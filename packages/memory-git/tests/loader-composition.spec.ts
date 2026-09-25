import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
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

async function write(ctx: Context, callId: string, id: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'wiki_write',
    arguments: { id, content: `content of ${id}` },
  })
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

    const log = await gitLog(vault)
    expect(log).toContain('wiki_write: shared/summary.md')
    expect(log).not.toContain('agents/agent-1/notes/x.md')
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
})
