import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MemoryScope from '@jacklika/dsh-memory-scope'
import * as ToolMemoryFilesystem from '@jacklika/dsh-tool-memory-filesystem'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the memory-scope plugin in front of the real
 * memory filesystem tools.
 * @param vaultRoot - absolute vault directory the tools resolve per call.
 * @param extraConfig - extra YAML lines appended under the plugin's `config:`.
 * @returns the booted context.
 */
async function boot(vaultRoot: string, extraConfig: string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-scope-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-memory-scope'",
    ...extraConfig.length > 0 ? ['  config:', ...extraConfig] : [],
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
    ['@jacklika/dsh-memory-scope', MemoryScope],
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

function agent(id: string, cwd: string) {
  return { id, session: { header: { cwd } } } as never
}

async function write(ctx: Context, callId: string, id: string, agentId: string, cwd: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'wiki_write',
    arguments: { id, content: `from ${agentId}` },
    agent: agent(agentId, cwd),
  })
}

describe('memory-scope real Loader composition through cordis.yml', () => {
  it('namespaces writes per calling agent and reports the real on-disk id', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-scope-vault-'))
    const ctx = await boot(vault)

    const r1 = await write(ctx, 'w1', 'notes/x.md', 'agent-1', vault)
    expect(r1.isError).toBe(false)
    if (r1.isError) throw new Error('expected scoped wiki_write success')
    const out = JSON.parse(resultText(r1)) as { id: string }
    expect(out.id).toBe(join('agents', 'agent-1', 'notes', 'x.md'))
    expect(await readFile(join(vault, 'agents', 'agent-1', 'notes', 'x.md'), 'utf8')).toContain('from agent-1')

    // A second agent writing the same id lands in its own namespace.
    const r2 = await write(ctx, 'w2', 'notes/x.md', 'agent-2', vault)
    expect(r2.isError).toBe(false)
    expect(await readFile(join(vault, 'agents', 'agent-2', 'notes', 'x.md'), 'utf8')).toContain('from agent-2')

    // An id already inside the caller's namespace is not double-prefixed.
    const r3 = await write(ctx, 'w3', 'agents/agent-1/notes/y.md', 'agent-1', vault)
    expect(r3.isError).toBe(false)
    if (r3.isError) throw new Error('expected already-scoped wiki_write success')
    expect((JSON.parse(resultText(r3)) as { id: string }).id).toBe(join('agents', 'agent-1', 'notes', 'y.md'))
  })

  it('leaves shared zone ids untouched for queue or curator arbitration', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-scope-vault-'))
    const ctx = await boot(vault)

    const result = await write(ctx, 'shared-1', 'shared/summary.md', 'agent-1', vault)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected shared wiki_write success')
    expect((JSON.parse(resultText(result)) as { id: string }).id).toBe(join('shared', 'summary.md'))
    expect(await readFile(join(vault, 'shared', 'summary.md'), 'utf8')).toContain('from agent-1')
  })

  it('shares one namespace across sessions when agentKey is configured', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-scope-vault-'))
    const ctx = await boot(vault, ["    agentKey: 'main'"])

    const r1 = await write(ctx, 'k1', 'notes/x.md', 'session-a', vault)
    if (r1.isError) throw new Error('expected scoped wiki_write success')
    expect((JSON.parse(resultText(r1)) as { id: string }).id).toBe(join('agents', 'main', 'notes', 'x.md'))

    const r2 = await write(ctx, 'k2', 'notes/x.md', 'session-b', vault)
    if (r2.isError) throw new Error('expected second session write success')
    const text = await readFile(join(vault, 'agents', 'main', 'notes', 'x.md'), 'utf8')
    expect(text).toContain('from session-a')
    expect(text).toContain('from session-b')
  })

  it('passes every id through under the curator role', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-scope-vault-'))
    const ctx = await boot(vault, ['    role: curator'])

    const result = await write(ctx, 'cur-1', 'shared/summary.md', 'curator', vault)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected curator wiki_write success')
    expect((JSON.parse(resultText(result)) as { id: string }).id).toBe(join('shared', 'summary.md'))
  })
})
