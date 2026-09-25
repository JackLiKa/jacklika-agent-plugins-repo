import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
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
import * as ToolMemory from '@jacklika/dsh-tool-memory-filesystem'

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
 * Boot a cordis.yml carrying the memory-filesystem tool and an optional vault
 * directory. When `vaultRoot` is omitted the plugin resolves the memory root
 * per tool call from the session workspace.
 * @param vaultRoot - absolute path to the vault root, or undefined for
 *   session-workspace defaulting.
 * @returns the booted context.
 */
async function boot(vaultRoot?: string, indexHiddenDirs = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  const configPath = join(root, 'cordis.yml')
  const configLines = [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-tool-memory-filesystem'",
    ...vaultRoot !== undefined || indexHiddenDirs
      ? [
        '  config:',
        ...vaultRoot !== undefined ? [`    vaultRoot: ${vaultRoot}`] : [],
        ...indexHiddenDirs ? ['    indexHiddenDirs: true'] : [],
      ]
      : [],
    '',
  ]
  await writeFile(configPath, configLines.join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@jacklika/dsh-tool-memory-filesystem', ToolMemory],
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

async function makeVault(): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-vault-'))
  const concepts = join(vaultRoot, 'concepts')
  await mkdir(concepts)
  await writeFile(join(concepts, 'RAG.md'), '---\ntags: [llm, architecture]\n---\n\n# Retrieval-Augmented Generation\n\nRAG combines [[embedding]] retrieval with LLM generation.\n')
  await writeFile(join(vaultRoot, 'embedding.md'), '---\ntags: [llm]\n---\n\n# Embedding\n\nAn embedding is a dense vector. See also [[concepts/RAG]].\n')
  return vaultRoot
}

describe('tool-memory-filesystem real Loader composition through cordis.yml', () => {
  it('exposes wiki_read, wiki_search, and wiki_write tools with expected schemas', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toContain('wiki_read')
    expect(names).toContain('wiki_search')
    expect(names).toContain('wiki_write')
  })

  it('withdraws registered tools when the Loader entry unloads', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const tools = ctx.tools
    expect(tools.schemas().some(schema => schema.name === 'wiki_write')).toBe(true)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-tool-memory-filesystem')
    if (entry?.fiber === undefined) throw new Error('active memory tool entry missing')
    await entry.fiber.dispose()
    expect(tools.schemas().some(schema => schema.name === 'wiki_write')).toBe(false)
  })

  it('reads a note and follows Obsidian-style links', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('read-rag'),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_read success')
    const note = JSON.parse(resultText(result)) as { id: string; links: string[]; linkedNotes: unknown[] }
    expect(note.id).toBe('concepts/RAG.md')
    expect(note.links).toContain('embedding')
    expect(note.linkedNotes).toHaveLength(1)
  })

  it('searches notes by keyword', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-rag'),
      name: 'wiki_search',
      arguments: { query: 'RAG' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_search success')
    const hits = JSON.parse(resultText(result)) as { id: string }[]
    expect(hits.some(h => h.id === 'concepts/RAG.md')).toBe(true)
    expect(hits.some(h => h.id === 'embedding.md')).toBe(true)
  })

  it('appends to a note while preserving frontmatter', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const writeResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('write-rag'),
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: 'New insight.' },
    })
    expect(writeResult.isError).toBe(false)
    if (writeResult.isError) throw new Error('expected wiki_write success')

    const readResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('read-rag-after-write'),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })
    expect(readResult.isError).toBe(false)
    if (readResult.isError) throw new Error('expected wiki_read success')
    const note = JSON.parse(resultText(readResult)) as { body: string; frontmatter: Record<string, unknown> }
    expect(note.body).toContain('New insight.')
    expect(note.frontmatter.tags).toEqual(['llm', 'architecture'])
  })

  it('fails wiki_write with a stale baseVersion instead of silently overwriting', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)

    const readResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('read-for-version'),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })
    expect(readResult.isError).toBe(false)
    if (readResult.isError) throw new Error('expected wiki_read success')
    const note = JSON.parse(resultText(readResult)) as { version: string }
    expect(note.version).toMatch(/^[0-9a-f]{40}$/)

    // An uncoordinated writer changes the note between read and write.
    await writeFile(join(vault, 'concepts', 'RAG.md'), 'changed externally\n')

    const conflict = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('write-stale-version'),
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: 'x', baseVersion: note.version },
    })
    expect(conflict.isError).toBe(true)

    // Re-reading yields the new version; a write against it succeeds.
    const reread = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('reread-after-conflict'),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })
    expect(reread.isError).toBe(false)
    if (reread.isError) throw new Error('expected wiki_read success')
    const current = JSON.parse(resultText(reread)) as { version: string }

    const matching = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('write-matching-version'),
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: 'after external change', baseVersion: current.version },
    })
    expect(matching.isError).toBe(false)
  })

  it('rejects paths outside the vault root', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('escape-attempt'),
      name: 'wiki_read',
      arguments: { id: '../embedding.md' },
    })
    expect(result.isError).toBe(true)
  })

  it('rejects reads and writes through a symlink or junction that leaves the vault', async () => {
    const vault = await makeVault()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-memory-outside-'))
    await writeFile(join(outside, 'secret.md'), 'outside\n')
    await symlink(outside, join(vault, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = await boot(vault)

    const read = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('symlink-read'),
      name: 'wiki_read',
      arguments: { id: 'escape/secret.md' },
    })
    expect(read.isError).toBe(true)

    const write = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('symlink-write'),
      name: 'wiki_write',
      arguments: { id: 'escape/new.md', content: 'must not escape' },
    })
    expect(write.isError).toBe(true)
    await expect(readFile(join(outside, 'new.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(outside, { recursive: true, force: true })
  })

  it('defaults the vault to the calling session workspace under .dsh/memory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-memory-workspace-'))
    const ctx = await boot()
    const agent = { session: { header: { cwd: workspace } } } as never

    const writeResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('write-workspace-note'),
      name: 'wiki_write',
      arguments: { id: 'daily/2026-09-24.md', content: 'Workspace note.' },
      agent,
    })
    expect(writeResult.isError).toBe(false)
    if (writeResult.isError) throw new Error('expected wiki_write success')

    const memoryFile = join(workspace, '.dsh', 'memory', 'daily', '2026-09-24.md')
    const text = await readFile(memoryFile, 'utf8')
    expect(text).toContain('Workspace note.')

    const readResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('read-workspace-note'),
      name: 'wiki_read',
      arguments: { id: 'daily/2026-09-24.md' },
      agent,
    })
    expect(readResult.isError).toBe(false)
    if (readResult.isError) throw new Error('expected wiki_read success')
    const note = JSON.parse(resultText(readResult)) as { id: string }
    expect(note.id).toBe('daily/2026-09-24.md')
  })

  it('indexes .dsh notes only when indexHiddenDirs is enabled', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-memory-hidden-'))
    const hidden = join(workspace, '.dsh', 'memory')
    await mkdir(hidden, { recursive: true })
    await writeFile(join(hidden, 'secret.md'), '# Hidden note\n\nUnder the workspace dot directory.\n')

    const offCtx = await boot(workspace)
    const missResult = await offCtx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-hidden-off'),
      name: 'wiki_search',
      arguments: { query: 'Hidden' },
    })
    expect(missResult.isError).toBe(false)
    if (missResult.isError) throw new Error('expected wiki_search success')
    expect(JSON.parse(resultText(missResult))).toEqual([])

    await offCtx.fiber.dispose()
    context = undefined

    const onCtx = await boot(workspace, true)
    const hitResult = await onCtx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-hidden-on'),
      name: 'wiki_search',
      arguments: { query: 'Hidden' },
    })
    expect(hitResult.isError).toBe(false)
    if (hitResult.isError) throw new Error('expected wiki_search success')
    const hits = JSON.parse(resultText(hitResult)) as { id: string }[]
    expect(hits.some(h => h.id === join('.dsh', 'memory', 'secret.md'))).toBe(true)
  })
})
