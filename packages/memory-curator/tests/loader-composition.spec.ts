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
import * as MemoryCurator from '@jacklika/dsh-memory-curator'
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

async function boot(vaultRoot: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-curator-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-memory-curator'",
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
    ['@jacklika/dsh-memory-curator', MemoryCurator],
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

async function capture(
  ctx: Context,
  callId: string,
  title: string,
  summary: string,
  agentId: string,
  cwd: string,
  extra: Record<string, unknown> = {},
) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'memory_capture',
    arguments: { title, summary, ...extra },
    agent: agent(agentId, cwd),
  })
}

async function recall(ctx: Context, callId: string, query: string, agentId: string, cwd: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'memory_recall',
    arguments: { query },
    agent: agent(agentId, cwd),
  })
}

async function readNote(ctx: Context, callId: string, id: string, agentId: string, cwd: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'wiki_read',
    arguments: { id },
    agent: agent(agentId, cwd),
  })
}

describe('memory-curator real Loader composition through cordis.yml', () => {
  it('captures a new shared note and recalls it later', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)

    const r1 = await capture(ctx, 'c1', 'Project conventions', 'Use pnpm 11.7.0 and Node ^22.19.0.', 'agent-1', vault, { tags: ['conventions', 'node', 'pnpm'] })
    expect(r1.isError).toBe(false)
    const out1 = JSON.parse(resultText(r1)) as { written: boolean; id: string; mode: string }
    expect(out1.written).toBe(true)
    expect(out1.id).toBe('shared/notes/project-conventions.md')
    expect(out1.mode).toBe('overwrite')

    const r1r = await readNote(ctx, 'r1-read', 'shared/notes/project-conventions.md', 'agent-1', vault)
    expect(r1r.isError).toBe(false)
    const read1 = JSON.parse(resultText(r1r)) as { frontmatter: { title?: string; tags?: string[]; created?: string }; body: string }
    expect(read1.frontmatter.title).toBe('Project conventions')
    expect(read1.frontmatter.tags).toEqual(['conventions', 'node', 'pnpm'])
    expect(read1.frontmatter.created).toBeDefined()
    expect(read1.body).toContain('Use pnpm 11.7.0 and Node ^22.19.0.')

    const notePath = join(vault, 'shared', 'notes', 'project-conventions.md')
    const text = await readFile(notePath, 'utf8')
    expect(text.startsWith('---')).toBe(true)
    expect(text).toContain('title: Project conventions')
    expect(text).toContain('# Project conventions')
    expect(text).toContain('Use pnpm 11.7.0 and Node ^22.19.0.')

    const r2 = await recall(ctx, 'r1-recall', 'pnpm Node project conventions', 'agent-1', vault)
    expect(r2.isError).toBe(false)
    const out2 = JSON.parse(resultText(r2)) as { query: string; hits: { id: string; title: string; backlinks: string[] }[]; total: number }
    expect(out2.total).toBeGreaterThan(0)
    expect(out2.hits.some(hit => hit.id === 'shared/notes/project-conventions.md')).toBe(true)
  })

  it('appends to an existing note when the same title is captured again with conflictPolicy=skip', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)

    const r1 = await capture(ctx, 'c1', 'Bug fix', 'Fixed off-by-one in loop.', 'agent-1', vault)
    expect(r1.isError).toBe(false)
    const out1 = JSON.parse(resultText(r1)) as { written: boolean; id: string }
    expect(out1.id).toBe('shared/notes/bug-fix.md')

    const r2 = await capture(ctx, 'c2', 'Bug fix', 'Added regression test.', 'agent-1', vault, { conflictPolicy: 'skip' })
    expect(r2.isError).toBe(false)
    const out2 = JSON.parse(resultText(r2)) as { written: boolean; conflict: boolean; id: string }
    expect(out2.written).toBe(false)
    expect(out2.conflict).toBe(true)
    expect(out2.id).toBe('shared/notes/bug-fix.md')

    const text = await readFile(join(vault, 'shared', 'notes', 'bug-fix.md'), 'utf8')
    expect(text).toContain('Fixed off-by-one in loop.')
    expect(text).not.toContain('Added regression test.')
  })

  it('withdraws its tools when the Loader fiber unloads', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-memory-curator')
    if (entry?.fiber === undefined) throw new Error('active curator entry missing')
    await entry.fiber.dispose()

    const result = await capture(ctx, 'after-unload', 'Title', 'Summary', 'agent-1', vault)
    expect(result.isError).toBe(true)
  })
})
