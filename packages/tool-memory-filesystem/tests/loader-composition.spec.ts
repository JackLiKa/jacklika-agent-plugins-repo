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
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
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

/**
 * A vault laid out like the real `.plugins/memory/`: notes nested under
 * `shared/notes/` referencing each other by bare filename, the way Obsidian
 * users actually write links.
 */
async function makeNestedVault(): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-vault-nested-'))
  const dir = join(vaultRoot, 'shared', 'notes')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'a.md'), '# Alpha\n\nAlpha body mentions zephyr-token. See [[b]].\n')
  await writeFile(join(dir, 'b.md'), '# Beta\n\nBeta body has no shared keywords.\n')
  return vaultRoot
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

  it('matches keywords that appear only in the note body', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-body-only'),
      name: 'wiki_search',
      arguments: { query: 'dense vector' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_search success')
    const hits = JSON.parse(resultText(result)) as { id: string; title: string }[]
    expect(hits.some(h => h.id === 'embedding.md')).toBe(true)
    expect(hits.every(h => !Object.hasOwn(h, 'body'))).toBe(true)
  })

  it('OR-matches long queries and ranks by field-weighted score', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)

    // A term absent from the whole vault must not void the note that matched
    // the rest — under AND semantics this query returned nothing.
    const partial = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-partial'),
      name: 'wiki_search',
      arguments: { query: 'retrieval absent-xyzzy' },
    })
    if (partial.isError) throw new Error('expected wiki_search success')
    const partialHits = JSON.parse(resultText(partial)) as { id: string; score: number }[]
    // RAG.md matches 'retrieval' lexically; embedding.md matches nothing but
    // is linked from RAG.md, so the graph boost surfaces it second.
    expect(partialHits.map(h => h.id)).toEqual(['concepts/RAG.md', 'embedding.md'])
    expect(partialHits[0].score).toBeGreaterThan(partialHits[1].score)

    // 'rag' hits the embedding note's body AND backlink field plus its own
    // title/id; 'vector' only appears in embedding.md's body. The note that
    // matches both terms in heavier fields ranks first.
    const ranked = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-ranked'),
      name: 'wiki_search',
      arguments: { query: 'rag vector' },
    })
    if (ranked.isError) throw new Error('expected wiki_search success')
    const rankedHits = JSON.parse(resultText(ranked)) as { id: string; score: number }[]
    expect(rankedHits[0].id).toBe('embedding.md')
    expect(rankedHits.map(h => h.id)).toContain('concepts/RAG.md')
    expect(rankedHits.every(h => typeof h.score === 'number' && h.score > 0)).toBe(true)

    // Field weighting: 'embedding' appears in embedding.md's id+title (×3)
    // and body, but only as a body link inside RAG.md — the title hit wins.
    const fielded = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-fielded'),
      name: 'wiki_search',
      arguments: { query: 'embedding' },
    })
    if (fielded.isError) throw new Error('expected wiki_search success')
    const fieldedHits = JSON.parse(resultText(fielded)) as { id: string }[]
    expect(fieldedHits[0].id).toBe('embedding.md')
  })

  it('fails wiki_search when the semantic layer returns malformed output', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    ctx.tools.register(defineTool({
      name: 'wiki_semantic_search',
      description: 'stub',
      parameters: { query: { type: 'string', required: true } },
      output: {
        schema: { type: 'json' },
        // Deliberately malformed JSON: only dispatch failures are fail-soft;
        // a broken semantic payload must propagate instead of degrading.
        render: () => [{ type: 'text', text: '{not json' }],
      },
      async execute() {
        return []
      },
    }))
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-malformed-semantic'),
      name: 'wiki_search',
      arguments: { query: 'rag' },
    })
    expect(result.isError).toBe(true)
  })

  it('degrades to lexical hits when the semantic layer errors', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    ctx.tools.register(defineTool({
      name: 'wiki_semantic_search',
      description: 'stub',
      parameters: { query: { type: 'string', required: true } },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        throw new Error('embeddings endpoint down')
      },
    }))
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-semantic-down'),
      name: 'wiki_search',
      arguments: { query: 'rag' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_search success')
    const hits = JSON.parse(resultText(result)) as { id: string }[]
    expect(hits.map(h => h.id)).toContain('concepts/RAG.md')
  })

  it('resolves bare-filename links across nested directories', async () => {
    const vault = await makeNestedVault()
    const ctx = await boot(vault)

    // wiki_read must follow [[b]] to shared/notes/b.md.
    const read = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('read-nested-a'),
      name: 'wiki_read',
      arguments: { id: 'shared/notes/a.md' },
    })
    if (read.isError) throw new Error('expected wiki_read success')
    const note = JSON.parse(resultText(read)) as { links: string[]; linkedNotes: { id: string }[] }
    expect(note.links).toContain('b')
    expect(note.linkedNotes.map(n => n.id)).toContain('shared/notes/b.md')

    // buildIndex must record the backlink: searching b's id surfaces a.
    const search = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-nested-beta'),
      name: 'wiki_search',
      arguments: { query: 'beta' },
    })
    if (search.isError) throw new Error('expected wiki_search success')
    const hits = JSON.parse(resultText(search)) as { id: string; backlinks: string[] }[]
    const beta = hits.find(h => h.id === 'shared/notes/b.md')
    expect(beta?.backlinks).toContain('shared/notes/a.md')

    // Graph boost: 'zephyr-token' appears only in a.md, but b.md is linked
    // from it, so it must surface in the results.
    const boosted = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-nested-boost'),
      name: 'wiki_search',
      arguments: { query: 'zephyr-token' },
    })
    if (boosted.isError) throw new Error('expected wiki_search success')
    const boostedHits = JSON.parse(resultText(boosted)) as { id: string }[]
    expect(boostedHits.map(h => h.id)).toEqual(['shared/notes/a.md', 'shared/notes/b.md'])
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
    expect(note.body).toMatch(/## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00/)
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

  it('reports mtime and flags external modification via modifiedExternally', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const notePath = join(vault, 'concepts', 'RAG.md')
    const read = (callId: string) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(callId),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })

    // First observation records the mtime and reports no external change.
    const first = await read('mtime-first')
    if (first.isError) throw new Error('expected wiki_read success')
    const firstNote = JSON.parse(resultText(first)) as { mtime?: string; modifiedExternally?: boolean }
    expect(firstNote.mtime).toMatch(/\+08:00$/)
    expect(firstNote.modifiedExternally).toBe(false)

    // A repeat read with no write stays clean.
    const again = await read('mtime-again')
    if (again.isError) throw new Error('expected wiki_read success')
    expect(JSON.parse(resultText(again)).modifiedExternally).toBe(false)

    // An uncoordinated writer (Obsidian) bumps mtime; the next read flags it.
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(notePath, `${await readFile(notePath, 'utf8')}\nexternal edit\n`)
    const flagged = await read('mtime-flagged')
    if (flagged.isError) throw new Error('expected wiki_read success')
    expect(JSON.parse(resultText(flagged)).modifiedExternally).toBe(true)
  })

  it('does not flag the plugin\'s own wiki_write as an external modification', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const read = (callId: string) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(callId),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })

    const first = await read('own-first')
    if (first.isError) throw new Error('expected wiki_read success')

    const write = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('own-write'),
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: 'plugin-authored change' },
    })
    if (write.isError) throw new Error('expected wiki_write success')

    // The write bumped mtime on disk, but the write itself re-recorded it, so
    // the next read must not cry wolf.
    const after = await read('own-after')
    if (after.isError) throw new Error('expected wiki_read success')
    expect(JSON.parse(resultText(after)).modifiedExternally).toBe(false)
  })

  it('scopes modifiedExternally per note, not per vault', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const ragRead = (callId: string) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(callId),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })
    const embeddingRead = (callId: string) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(callId),
      name: 'wiki_read',
      arguments: { id: 'embedding.md' },
    })

    await ragRead('scope-rag-1')
    await embeddingRead('scope-emb-1')

    // A write to one note must not flag its neighbour.
    const write = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('scope-write'),
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: 'unrelated update' },
    })
    if (write.isError) throw new Error('expected wiki_write success')

    const neighbour = await embeddingRead('scope-emb-2')
    if (neighbour.isError) throw new Error('expected wiki_read success')
    expect(JSON.parse(resultText(neighbour)).modifiedExternally).toBe(false)
  })

  it('normalizes created/updated to +08:00 on overwrite writes', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('norm-overwrite'),
      name: 'wiki_write',
      arguments: {
        id: 'norm-target.md',
        mode: 'overwrite',
        content: '---\ncreated: \'2026-10-06T08:18:03.391Z\'\nupdated: \'2026-10-06T08:00:00+00:00\'\n---\n\n# Norm\n\nBody.\n',
      },
    })
    if (result.isError) throw new Error('expected wiki_write success')
    const text = await readFile(join(vault, 'norm-target.md'), 'utf8')
    expect(text).toContain('2026-10-06T16:18:03+08:00')
    expect(text).toContain('2026-10-06T16:00:00+08:00')
    expect(text).not.toContain('Z\'')
    expect(text).not.toContain('+00:00')

    // Already-normalized second-precision +08:00 input passes through untouched.
    const stable = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('norm-stable'),
      name: 'wiki_write',
      arguments: {
        id: 'norm-stable.md',
        mode: 'overwrite',
        content: '---\ncreated: \'2026-10-06T16:18:03+08:00\'\n---\n\n# Stable\n',
      },
    })
    if (stable.isError) throw new Error('expected wiki_write success')
    const stableText = await readFile(join(vault, 'norm-stable.md'), 'utf8')
    expect(stableText).toContain('created: \'2026-10-06T16:18:03+08:00\'')
  })

  it('normalizes timestamps on append and leaves unparseable values alone', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-memory-vault-norm-'))
    await writeFile(
      join(vault, 'a.md'),
      '---\ncreated: \'2026-10-06T08:18:03.391Z\'\nupdated: not-a-date\n---\n\n# A\n',
    )
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('norm-append'),
      name: 'wiki_write',
      arguments: { id: 'a.md', content: 'appended.' },
    })
    if (result.isError) throw new Error('expected wiki_write success')
    const text = await readFile(join(vault, 'a.md'), 'utf8')
    expect(text).toContain('2026-10-06T16:18:03+08:00')
    expect(text).toContain('not-a-date')
    expect(text).toContain('appended.')
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
    expect(hits.some(h => h.id === '.dsh/memory/secret.md')).toBe(true)
  })
})
