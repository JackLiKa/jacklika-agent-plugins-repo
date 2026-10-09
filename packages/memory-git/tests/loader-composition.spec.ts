import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MemoryGit from '@jacklika/dsh-memory-git'
import * as ToolMemoryFilesystem from '@jacklika/dsh-tool-memory-filesystem'

const execFileAsync = promisify(execFile)

let root: string | undefined
let context: Context | undefined
const vaults: string[] = []

/** A throwaway vault directory, removed with the loader tree after the test. */
async function vault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-git-vault-'))
  vaults.push(dir)
  return dir
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await Promise.all(vaults.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * Boot a cordis.yml carrying the memory-git plugin in front of the real
 * memory filesystem tools.
 * @param vaultRoot - absolute vault directory the tools resolve per call.
 * @param extraConfig - extra YAML lines appended under the plugin's `config:`.
 * @returns the booted context.
 */
async function boot(vaultRoot: string, extraConfig: string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-memory-git'",
    '  config:',
    `    vaultRoot: ${vaultRoot}`,
    ...extraConfig,
    "- name: '@jacklika/dsh-tool-memory-filesystem'",
    '  config:',
    `    vaultRoot: ${vaultRoot}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@jacklika/dsh-memory-git', MemoryGit],
    ['@jacklika/dsh-tool-memory-filesystem', ToolMemoryFilesystem],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function write(
  ctx: Context,
  callId: string,
  id: string,
  content = `content of ${id}`,
  extra: Record<string, unknown> = {},
) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'wiki_write',
    arguments: { id, content, ...extra },
  })
}

function resultText(result: { content?: { type: string; text?: string }[]; error?: { message: string } }): string {
  const blocks = result.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
  return `${blocks}${result.error?.message ?? ''}`
}

/** Make every `git commit` in `dir` fail, leaving `add` and `status` working. */
async function plantFailingPreCommit(dir: string): Promise<string> {
  const hook = join(dir, '.git', 'hooks', 'pre-commit')
  await mkdir(join(dir, '.git', 'hooks'), { recursive: true })
  await writeFile(hook, '#!/bin/sh\nexit 1\n')
  await chmod(hook, 0o755)
  return hook
}

async function gitLog(vault: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', vault, 'log', '--format=%s', '--name-only'])
  return stdout
}

describe('memory-git real Loader composition through cordis.yml', () => {
  it('commits shared-zone writes to a vault git repository', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-git-vault-'))
    const ctx = await boot(vault)

    const result = await write(ctx, 'w1', 'shared/summary.md')
    expect(result.isError).toBe(false)

    const log = await gitLog(vault)
    expect(log).toContain('wiki_write: shared/summary.md')
    expect(log).toContain('shared/summary.md')
  })

  it('withdraws its tools/execute wrapper when the Loader fiber unloads', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-git-vault-'))
    const ctx = await boot(vault)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-memory-git')
    if (entry?.fiber === undefined) throw new Error('active git entry missing')
    await entry.fiber.dispose()
    const result = await write(ctx, 'untracked', 'shared/untracked.md')
    expect(result.isError).toBe(false)
    await expect(gitLog(vault)).rejects.toBeDefined()
  })

  it('leaves writes outside the configured prefixes uncommitted', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-git-vault-'))
    const ctx = await boot(vault)

    const private_ = await write(ctx, 'w1', 'agents/agent-1/notes/x.md')
    expect(private_.isError).toBe(false)
    const shared = await write(ctx, 'w2', 'shared/summary.md')
    expect(shared.isError).toBe(false)
    const loose = await write(ctx, 'w3', 'loose/note.md')
    expect(loose.isError).toBe(false)

    const log = await gitLog(vault)
    expect(log).toContain('wiki_write: shared/summary.md')
    // The default prefixes cover shared/ and agents/: agents/ writes are
    // versioned because the namespace split is collision avoidance, not
    // privacy — but an id outside both prefixes is still left uncommitted.
    expect(log).toContain('wiki_write: agents/agent-1/notes/x.md')
    expect(log).not.toContain('loose/note.md')
  })

  it('creates an own .git inside a nested vault instead of joining the parent repo', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-git-parent-'))
    await execFileAsync('git', ['-C', parent, 'init'])
    const vault = join(parent, '.dsh', 'memory')
    const ctx = await boot(vault)

    const result = await write(ctx, 'w1', 'shared/summary.md')
    expect(result.isError).toBe(false)

    // The vault owns its repository; the parent repo's history is untouched.
    const vaultLog = await gitLog(vault)
    expect(vaultLog).toContain('wiki_write: shared/summary.md')
    const { stdout: parentLog } = await execFileAsync(
      'git', ['-C', parent, 'log', '--format=%s', '--all'],
    ).catch(() => ({ stdout: '', stderr: '' }))
    expect(parentLog).not.toContain('wiki_write: shared/summary.md')
  })

  it('commits every write when prefixes is empty', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-git-vault-'))
    const ctx = await boot(vault, ['    prefixes: []'])

    const result = await write(ctx, 'w1', 'agents/agent-1/notes/x.md')
    expect(result.isError).toBe(false)

    const log = await gitLog(vault)
    expect(log).toContain('wiki_write: agents/agent-1/notes/x.md')
  })

  it('reports the note as written-but-uncommitted when git is missing from PATH', async () => {
    const dir = await vault()
    const ctx = await boot(dir)
    const path = process.env.PATH
    process.env.PATH = ''
    let result: Awaited<ReturnType<typeof write>>
    try {
      result = await write(ctx, 'w-nogit', 'shared/summary.md')
    } finally {
      process.env.PATH = path
    }

    expect(result.isError).toBe(true)
    const text = resultText(result)
    expect(text).toContain('note shared/summary.md was written to the vault but not committed')
    expect(text).toContain('baseVersion')
    expect(text).toContain('git executable was not found on PATH')

    // The divergence is real: the note is on disk and the vault has no history.
    expect(await readFile(join(dir, 'shared', 'summary.md'), 'utf8')).toContain('content of shared/summary.md')
    await expect(gitLog(dir)).rejects.toBeDefined()
  })

  it('keeps the note on disk and out of history when the commit step itself fails', async () => {
    const dir = await vault()
    const ctx = await boot(dir)
    const committed = await write(ctx, 'w1', 'shared/summary.md')
    expect(committed.isError).toBe(false)
    await plantFailingPreCommit(dir)

    const failed = await write(ctx, 'w2', 'shared/second.md')
    expect(failed.isError).toBe(true)
    expect(resultText(failed)).toContain('note shared/second.md was written to the vault but not committed')

    expect(await readFile(join(dir, 'shared', 'second.md'), 'utf8')).toContain('content of shared/second.md')
    const log = await gitLog(dir)
    expect(log).toContain('wiki_write: shared/summary.md')
    expect(log).not.toContain('wiki_write: shared/second.md')
    // The uncommitted note stays visible to `git status`, so the residue is diagnosable.
    const { stdout: status } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain'])
    expect(status).toContain('shared/second.md')
  })

  it('fails fast with the same guidance while index.lock stays held', async () => {
    const dir = await vault()
    const ctx = await boot(dir, ['    indexLockRetries: 1', '    indexLockRetryMs: 1'])
    const committed = await write(ctx, 'w1', 'shared/summary.md')
    expect(committed.isError).toBe(false)
    await writeFile(join(dir, '.git', 'index.lock'), '')

    const blocked = await write(ctx, 'w2', 'shared/blocked.md')
    expect(blocked.isError).toBe(true)
    const text = resultText(blocked)
    expect(text).toContain('note shared/blocked.md was written to the vault but not committed')
    expect(text).toContain('index.lock')
    expect(await readFile(join(dir, 'shared', 'blocked.md'), 'utf8')).toContain('content of shared/blocked.md')
    const log = await gitLog(dir)
    expect(log).toContain('wiki_write: shared/summary.md')
    expect(log).not.toContain('wiki_write: shared/blocked.md')

    await rm(join(dir, '.git', 'index.lock'))
  })

  // Pins the hazard the partial-success message warns about: after a failed
  // commit the note is already on disk, so repeating the identical append
  // without re-reading appends the same section a second time.
  it('duplicates an appended section when the same append is retried after a commit failure', async () => {
    const dir = await vault()
    const ctx = await boot(dir)
    expect((await write(ctx, 'w1', 'shared/log.md', '# Log\n')).isError).toBe(false)
    const hook = await plantFailingPreCommit(dir)

    const failedAppend = await write(ctx, 'w2', 'shared/log.md', '## Turn 1\n', { mode: 'append' })
    expect(failedAppend.isError).toBe(true)
    expect(resultText(failedAppend)).toContain('duplicates the appended section')

    await rm(hook)
    const retried = await write(ctx, 'w3', 'shared/log.md', '## Turn 1\n', { mode: 'append' })
    expect(retried.isError).toBe(false)
    const text = await readFile(join(dir, 'shared', 'log.md'), 'utf8')
    expect(text.match(/## Turn 1/g)).toHaveLength(2)
    expect(await gitLog(dir)).toContain('wiki_write: shared/log.md')
  })
})
