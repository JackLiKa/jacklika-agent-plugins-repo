import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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
import * as ToolMemoryGraph from '@jacklika/dsh-tool-memory-graph'

let root: string | undefined
let context: Context | undefined
const vaults: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await Promise.all(vaults.splice(0).map(vault => rm(vault, { recursive: true, force: true })))
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the memory-graph tool and a vault directory.
 * @param vaultRoot - absolute path to the vault root.
 * @returns the booted context.
 */
async function boot(vaultRoot: string, extraConfig: string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-graph-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-tool-memory-graph'",
    '  config:',
    `    vaultRoot: ${vaultRoot}`,
    ...extraConfig,
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
    ['@jacklika/dsh-tool-memory-graph', ToolMemoryGraph],
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
  const vaultRoot = await mkdtemp(join(tmpdir(), 'dsh-graph-vault-'))
  vaults.push(vaultRoot)
  const concepts = join(vaultRoot, 'concepts')
  await mkdir(concepts)
  await writeFile(join(concepts, 'RAG.md'), '# Retrieval-Augmented Generation\n\nRAG combines [[embedding]] retrieval with LLM generation.\n')
  await writeFile(join(vaultRoot, 'embedding.md'), '# Embedding\n\nAn embedding is a dense vector. See also [[concepts/RAG]].\n')
  await writeFile(join(vaultRoot, 'island.md'), '# Island\n\nNo links here.\n')
  return vaultRoot
}

async function makeKeywordVault(): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'dsh-graph-keyword-'))
  vaults.push(vaultRoot)
  const notes = join(vaultRoot, 'notes')
  await mkdir(notes)
  await writeFile(join(notes, 'b.md'), '# B\n\nB contains word1.\n')
  await writeFile(join(notes, 'c.md'), '# C\n\nC contains word1 and word2.\n')
  await writeFile(join(notes, 'd.md'), '# D\n\nD is unrelated.\n')
  return vaultRoot
}

/** The parsed `wiki_graph` payload. */
interface Graph {
  nodes: { id: string; title: string }[]
  edges: { from: string; to: string; type?: 'link' | 'keyword'; keywords?: string[]; weight?: number }[]
  truncated: boolean
  edgesTruncated: boolean
  nodesTotal: number
  nodesReturned: number
  edgesTotal: number
  edgesReturned: number
  edgesDropped: number
  effectiveMaxNodes: number
  effectiveMaxEdges: number
  excludedDirs: string[]
  depth?: number
}

async function graphAll(ctx: Context, callId: string): Promise<Graph> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'wiki_graph',
    arguments: {},
  })
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected wiki_graph success')
  return JSON.parse(resultText(result)) as Graph
}

async function graphFrom(ctx: Context, callId: string, id: string, depth: number): Promise<Graph> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'wiki_graph',
    arguments: { id, depth },
  })
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected wiki_graph success')
  return JSON.parse(resultText(result)) as Graph
}

describe('tool-memory-graph real Loader composition through cordis.yml', () => {
  it('exposes the wiki_graph tool', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('wiki_graph')
    expect(names).toContain('wiki_graph_audit')
    expect(names).toContain('wiki_graph_page')
  })

  it('withdraws wiki_graph when its Loader fiber unloads', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const tools = ctx.tools
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-tool-memory-graph')
    if (entry?.fiber === undefined) throw new Error('active graph entry missing')
    await entry.fiber.dispose()
    expect(tools.schemas().some(schema => schema.name === 'wiki_graph')).toBe(false)
    expect(tools.schemas().some(schema => schema.name === 'wiki_graph_audit')).toBe(false)
    expect(tools.schemas().some(schema => schema.name === 'wiki_graph_page')).toBe(false)
  })

  it('returns the full vault graph with nodes and resolved edges', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('graph-all'),
      name: 'wiki_graph',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_graph success')
    const graph = JSON.parse(resultText(result)) as {
      nodes: { id: string; title: string }[]
      edges: { from: string; to: string }[]
      truncated: boolean
      edgesTruncated: boolean
    }
    expect(graph.nodes.map(n => n.id).sort()).toEqual(['concepts/RAG.md', 'embedding.md', 'island.md'])
    expect(graph.nodes.find(n => n.id === 'concepts/RAG.md')?.title).toBe('Retrieval-Augmented Generation')
    expect(graph.edges).toContainEqual({ from: 'concepts/RAG.md', to: 'embedding.md' })
    expect(graph.edges).toContainEqual({ from: 'embedding.md', to: 'concepts/RAG.md' })
    expect(graph.truncated).toBe(false)
    expect(graph.edgesTruncated).toBe(false)
  })

  it('excludes archived nodes and does not redirect links into the archive', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-graph-archive-'))
    try {
      await mkdir(join(vault, 'archive', 'shared', 'notes'), { recursive: true })
      await mkdir(join(vault, 'shared', 'notes'), { recursive: true })
      await writeFile(join(vault, 'shared', 'notes', 'link.md'), '# Link\n\n[[shared/notes/target.md]]\n')
      await writeFile(join(vault, 'archive', 'shared', 'notes', 'target.md'), '# Target\n\nArchived token.\n')
      const ctx = await boot(vault)
      const whole = await graphAll(ctx, 'archive-whole')
      const subgraph = await graphFrom(ctx, 'archive-subgraph', 'shared/notes/link.md', 1)
      for (const graph of [whole, subgraph]) {
        expect(graph.nodes.map(node => node.id)).toEqual(['shared/notes/link.md'])
        expect(graph.edges).toEqual([])
      }
      const archived = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId('archive-center'),
        name: 'wiki_graph', arguments: { id: 'archive/shared/notes/target.md', depth: 1 },
      })
      expect(archived.isError).toBe(true)
      if (!archived.isError) throw new Error('expected excluded archive center to fail')
      expect(archived.error.message).toContain('excluded by excludeDirs')
      expect(archived.error.message).toContain('archive/shared/notes/target.md')
      const missing = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId('archive-missing-center'),
        name: 'wiki_graph', arguments: { id: 'archive/shared/notes/missing.md', depth: 1 },
      })
      expect(missing.isError).toBe(true)
      if (!missing.isError) throw new Error('expected missing archive center to fail')
      expect(missing.error.message).toContain('note not found')
      expect(whole.excludedDirs).toContain('archive')
      expect(subgraph.excludedDirs).toContain('archive')
      expect(subgraph.edgesTruncated).toBe(false)
      const auditResult = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId('archive-audit'),
        name: 'wiki_graph_audit', arguments: {},
      })
      expect(auditResult.isError).toBe(false)
      if (auditResult.isError) throw new Error(auditResult.error.message)
      expect(JSON.parse(resultText(auditResult))).toMatchObject({
        indexedNodes: 1, checkedLinks: 1, excludedDirsApplied: ['archive'],
        excludedNodesInIndex: 0, excludedEdgeEndpoints: 0,
        skippedEntries: 0, scanStable: true, complete: true,
        snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    } finally {
      await context?.fiber.dispose()
      context = undefined
      await rm(vault, { recursive: true, force: true })
    }
  })

  it('returns only the reachable subgraph for a center note and depth', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('graph-sub'),
      name: 'wiki_graph',
      arguments: { id: 'concepts/RAG.md', depth: 1 },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_graph success')
    const graph = JSON.parse(resultText(result)) as {
      nodes: { id: string }[]
      edges: { from: string; to: string }[]
    }
    expect(graph.nodes.map(n => n.id).sort()).toEqual(['concepts/RAG.md', 'embedding.md'])
    expect(graph.nodes.some(n => n.id === 'island.md')).toBe(false)
    expect(graph.edges).toContainEqual({ from: 'embedding.md', to: 'concepts/RAG.md' })
  })

  it('truncates the vault graph to the lowest ids, not to readdir order', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-graph-vault-'))
    // `listNotePaths` walks depth-first, so it yields `notes/*` before the root
    // file `notes-x.md` even though `-` sorts before `/`: a cap over traversal
    // order keeps a different subset than a cap over id order.
    await mkdir(join(vault, 'notes'))
    await writeFile(join(vault, 'notes', 'zzz.md'), '# Zzz\n')
    await writeFile(join(vault, 'notes', 'mmm.md'), '# Mmm\n')
    await writeFile(join(vault, 'notes-x.md'), '# Notes X\n')
    const ctx = await boot(vault, ['    maxNodes: 2'])

    const graph = await graphAll(ctx, 'graph-cap')
    expect(graph.truncated).toBe(true)
    expect(graph.nodes.map(node => node.id)).toEqual(['notes-x.md', 'notes/mmm.md'])
    expect(graph).toMatchObject({ nodesTotal: 3, nodesReturned: 2, edgesTotal: 0, edgesReturned: 0, edgesDropped: 0 })
  })

  it('truncates a subgraph by distance from the center, keeping the center and its nearest notes', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-graph-vault-'))
    await writeFile(join(vault, 'center.md'), '# Center\n\nSee [[zeta]].\n')
    await writeFile(join(vault, 'zeta.md'), '# Zeta\n\nSee [[alpha]].\n')
    await writeFile(join(vault, 'alpha.md'), '# Alpha\n')
    const ctx = await boot(vault, ['    maxNodes: 2'])

    const graph = await graphFrom(ctx, 'graph-sub-cap', 'center.md', 2)
    expect(graph.truncated).toBe(true)
    // The two-hop note sorts first by id, but the cap keeps the neighborhood:
    // dropping the direct link target would leave the center unconnected.
    expect(graph.nodes.map(node => node.id)).toEqual(['center.md', 'zeta.md'])
    expect(graph.edges).toEqual([{ from: 'center.md', to: 'zeta.md' }])
    expect(graph).toMatchObject({ nodesTotal: 3, nodesReturned: 2, edgesTotal: 1, edgesReturned: 1, edgesDropped: 0 })
    for (const edge of graph.edges) {
      expect(graph.nodes.some(node => node.id === edge.from)).toBe(true)
      expect(graph.nodes.some(node => node.id === edge.to)).toBe(true)
    }
  })

  it('derives keyword edges from shared terms and updates them after a note is rewritten', async () => {
    const vault = await makeKeywordVault()
    const ctx = await boot(vault)

    const before = await graphAll(ctx, 'keyword-before')
    const beforeEdge = before.edges.find(
      e => e.from === 'notes/b.md' && e.to === 'notes/c.md' && e.type === 'keyword',
    )
    expect(beforeEdge).toBeDefined()
    expect(beforeEdge?.keywords).toContain('word1')
    expect(beforeEdge?.weight).toBeGreaterThan(0)

    // Rewrite B: drop word1, introduce word2. C still has both word1 and word2.
    await writeFile(join(vault, 'notes', 'b.md'), '# B\n\nB now uses word2.\n')
    const after = await graphAll(ctx, 'keyword-after')

    const staleEdge = after.edges.find(
      e => e.from === 'notes/b.md' && e.to === 'notes/c.md' && e.keywords?.includes('word1'),
    )
    expect(staleEdge).toBeUndefined()

    const updatedEdge = after.edges.find(
      e => e.from === 'notes/b.md' && e.to === 'notes/c.md' && e.type === 'keyword' && e.keywords?.includes('word2'),
    )
    expect(updatedEdge).toBeDefined()
    expect(updatedEdge?.keywords).toEqual(['word2'])
    expect(updatedEdge?.weight).toBe(2)

    // D is isolated: no edges to or from it.
    expect(after.edges.some(e => e.from === 'notes/d.md' || e.to === 'notes/d.md')).toBe(false)
  })

  it('rejects a graph center that is not an indexed note instead of crashing', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)

    for (const [callId, id] of [['graph-missing', 'missing.md'], ['graph-directory', 'concepts']] as const) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(callId),
        name: 'wiki_graph',
        arguments: { id },
      })
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('expected wiki_graph failure')
      expect(result.error.message).toContain('note not found')
      expect(result.error.message).toContain(id)
    }
  })

  it.skipIf(process.platform === 'win32')('skips an unreadable note instead of failing the whole graph', async () => {
    const vault = await makeVault()
    const island = join(vault, 'island.md')
    await chmod(island, 0o000)
    try {
      const ctx = await boot(vault)

      const graph = await graphAll(ctx, 'graph-skip')
      expect(graph.nodes.map(node => node.id).sort()).toEqual(['concepts/RAG.md', 'embedding.md'])

      // Centering on the skipped note names the read failure, not "missing".
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('graph-skip-center'),
        name: 'wiki_graph',
        arguments: { id: 'island.md', depth: 1 },
      })
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('expected wiki_graph failure')
      expect(result.error.message).toContain('cannot read note "island.md"')
      const audit = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId('graph-skip-audit'),
        name: 'wiki_graph_audit', arguments: {},
      })
      expect(audit.isError).toBe(false)
      if (audit.isError) throw new Error(audit.error.message)
      expect(JSON.parse(resultText(audit))).toMatchObject({ complete: false, skippedEntries: 1 })
    } finally {
      await chmod(island, 0o644)
    }
  })

  it('caps edges at maxEdges in link-first order and reports edgesTruncated', async () => {
    const vault = await makeKeywordVault()
    const ctx = await boot(vault, ['    maxEdges: 1'])

    const graph = await graphAll(ctx, 'graph-edge-cap')
    expect(graph.edgesTruncated).toBe(true)
    expect(graph.edges).toHaveLength(1)
    // Both keyword edges between B and C are candidates; the deterministic
    // order keeps the same one regardless of directory-listing order.
    expect(graph.edges[0]?.from).toBe('notes/b.md')
    expect(graph.edges[0]?.to).toBe('notes/c.md')
    expect(graph.edges[0]?.type).toBe('keyword')
    expect(graph.edges[0]?.keywords).toEqual(['contains', 'word1'])
    expect(graph).toMatchObject({
      nodesTotal: 3, nodesReturned: 3, edgesTotal: 2, edgesReturned: 1, edgesDropped: 1,
      effectiveMaxNodes: 200, effectiveMaxEdges: 1, excludedDirs: ['archive'],
    })
    expect(graph.edgesReturned + graph.edgesDropped).toBe(graph.edgesTotal)
  })

  it('clamps per-call edge and node budgets and reports the effective caps', async () => {
    const vault = await makeKeywordVault()
    const ctx = await boot(vault, ['    maxNodes: 2', '    maxNodesLimit: 3', '    maxEdges: 1', '    maxEdgesLimit: 4'])
    const query = async (callId: string, args: Record<string, number>) => {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(callId), name: 'wiki_graph', arguments: args,
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error(result.error.message)
      return JSON.parse(resultText(result)) as Graph
    }
    const capped = await query('budget-default', {})
    expect(capped).toMatchObject({ nodesTotal: 3, nodesReturned: 2, truncated: true, effectiveMaxNodes: 2, effectiveMaxEdges: 1 })
    const exhaustive = await query('budget-exhaustive', { maxNodes: 3, maxEdges: 4 })
    expect(exhaustive).toMatchObject({
      nodesTotal: 3, nodesReturned: 3, truncated: false, effectiveMaxNodes: 3,
      edgesTotal: 2, edgesReturned: 2, edgesDropped: 0, edgesTruncated: false, effectiveMaxEdges: 4,
    })
    const clamped = await query('budget-clamped', { maxNodes: 9999, maxEdges: 9999 })
    expect(clamped).toMatchObject({ effectiveMaxNodes: 3, effectiveMaxEdges: 4, nodesTotal: 3, edgesTotal: 2 })
    expect(clamped.edges).toEqual(exhaustive.edges)
    expect(await query('budget-repeat', { maxNodes: 3, maxEdges: 4 })).toEqual(exhaustive)
    for (const graph of [capped, exhaustive, clamped]) {
      expect(graph.nodesReturned).toBe(graph.nodes.length)
      expect(graph.edgesReturned).toBe(graph.edges.length)
      expect(graph.edgesReturned + graph.edgesDropped).toBe(graph.edgesTotal)
    }
  })

  it('pages complete graph nodes and edges with a stable content cursor', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault, ['    pageSizeLimit: 2'])
    const call = async (callId: string, args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(callId),
        name: 'wiki_graph_page', arguments: args,
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error(result.error.message)
      return JSON.parse(resultText(result)) as {
        kind: string; nodes?: { id: string }[]; edges?: { from: string; to: string }[];
        total: number; pageSize: number; offset: number; snapshotId: string; nextCursor: string | null
      }
    }
    const graph = await graphAll(ctx, 'page-expected-graph')
    const nodeIds: string[] = []
    const edgeKeys: string[] = []
    for (const kind of ['nodes', 'edges'] as const) {
      let cursor: string | null = null
      let pages = 0
      do {
        const args = { kind, pageSize: 1, ...(cursor === null ? {} : { cursor }) }
        const page = await call(`page-${kind}-${pages}`, args)
        expect(page.kind).toBe(kind)
        expect(page.pageSize).toBe(1)
        expect(page.total).toBe(kind === 'nodes' ? graph.nodes.length : graph.edges.length)
        expect(page.snapshotId).toMatch(/^[a-f0-9]{64}$/)
        nodeIds.push(...(page.nodes ?? []).map(node => node.id))
        edgeKeys.push(...(page.edges ?? []).map(edge => `${edge.from}->${edge.to}`))
        cursor = page.nextCursor
        pages++
        expect(pages).toBeLessThan(20)
      } while (cursor !== null)
    }
    expect(nodeIds).toEqual(graph.nodes.map(node => node.id))
    expect(edgeKeys.sort()).toEqual(graph.edges.map(edge => `${edge.from}->${edge.to}`).sort())
    const clamped = await call('page-clamped', { kind: 'nodes', pageSize: 9999 })
    expect(clamped.pageSize).toBe(2)
    expect(clamped.nodes).toHaveLength(2)
    expect(await call('page-repeat', { kind: 'nodes', pageSize: 9999 })).toEqual(clamped)
    expect(clamped.nextCursor).not.toBeNull()
    for (const args of [
      { kind: 'nodes', cursor: 'not-a-cursor' },
      { kind: 'edges', cursor: clamped.nextCursor },
    ]) {
      const invalid = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`page-invalid-${args.kind}`),
        name: 'wiki_graph_page', arguments: args,
      })
      expect(invalid.isError).toBe(true)
      if (!invalid.isError) throw new Error('expected invalid graph cursor')
      expect(invalid.error.message).toContain('invalid graph cursor')
    }
    await writeFile(join(vault, 'embedding.md'), '# Embedding changed\n\nNew text.\n')
    const stale = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('page-stale'),
      name: 'wiki_graph_page', arguments: { kind: 'nodes', pageSize: 2, cursor: clamped.nextCursor },
    })
    expect(stale.isError).toBe(true)
    if (!stale.isError) throw new Error('expected stale graph cursor')
    expect(stale.error.message).toContain('stale graph snapshot')
  })

  it('continues a stateless cursor in a fresh plugin context', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const first = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('fresh-page-first'),
      name: 'wiki_graph_page', arguments: { kind: 'nodes', pageSize: 1 },
    })
    expect(first.isError).toBe(false)
    if (first.isError) throw new Error(first.error.message)
    const cursor = (JSON.parse(resultText(first)) as { nextCursor: string | null }).nextCursor
    expect(cursor).not.toBeNull()
    const fresh = new Context()
    try {
      await fresh.plugin(SystemPrompt)
      await fresh.plugin(ToolRuntime)
      await fresh.plugin(ToolMemoryGraph, { vaultRoot: vault })
      const second = await fresh.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId('fresh-page-second'),
        name: 'wiki_graph_page', arguments: { kind: 'nodes', pageSize: 1, cursor },
      })
      expect(second.isError).toBe(false)
      if (second.isError) throw new Error(second.error.message)
      expect(JSON.parse(resultText(second))).toMatchObject({ offset: 1, pageSize: 1 })
    } finally {
      await fresh.fiber.dispose()
    }
  })

  it('keeps subgraph paging cursors bound to the center and depth', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const id = 'concepts/RAG.md'
    const first = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('subgraph-page-first'),
      name: 'wiki_graph_page', arguments: { kind: 'edges', id, depth: 1, pageSize: 1 },
    })
    expect(first.isError).toBe(false)
    if (first.isError) throw new Error(first.error.message)
    const page = JSON.parse(resultText(first)) as { nextCursor: string | null; total: number; edges: unknown[] }
    expect(page.total).toBeGreaterThan(1)
    expect(page.edges).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
    const second = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('subgraph-page-second'),
      name: 'wiki_graph_page', arguments: { kind: 'edges', id, depth: 1, pageSize: 1, cursor: page.nextCursor },
    })
    expect(second.isError).toBe(false)
    for (const args of [
      { kind: 'edges', id, depth: 2, cursor: page.nextCursor },
      { kind: 'edges', id: 'embedding.md', depth: 1, cursor: page.nextCursor },
    ]) {
      const wrong = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`subgraph-page-mismatch-${args.depth}-${args.id}`),
        name: 'wiki_graph_page', arguments: args,
      })
      expect(wrong.isError).toBe(true)
      if (!wrong.isError) throw new Error('expected mismatched graph cursor')
      expect(wrong.error.message).toContain('invalid graph cursor')
    }
  })

  it('pages beyond legacy single-call caps without returning an unbounded page', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault, [
      '    maxNodes: 1', '    maxNodesLimit: 1', '    maxEdges: 1', '    maxEdgesLimit: 1',
      '    pageSizeLimit: 2', '    pageScanNodesLimit: 3', '    pageScanEdgesLimit: 100',
    ])
    const capped = await graphAll(ctx, 'legacy-cap')
    expect(capped.nodes).toHaveLength(1)
    const page = async (kind: string, cursor?: string, pageSize = 100) => {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`beyond-cap-${kind}-${cursor === undefined ? 0 : 1}`),
        name: 'wiki_graph_page', arguments: { kind, pageSize, ...(cursor === undefined ? {} : { cursor }) },
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error(result.error.message)
      return JSON.parse(resultText(result)) as { nodes: { id: string }[]; edges: unknown[]; total: number; pageSize: number; nextCursor: string | null }
    }
    const nodes = await page('nodes')
    expect(nodes).toMatchObject({ total: 3, pageSize: 2 })
    expect(nodes.nodes).toHaveLength(2)
    expect(nodes.nextCursor).not.toBeNull()
    expect((await page('nodes', nodes.nextCursor!)).nodes).toHaveLength(1)
    const edges = await page('edges', undefined, 1)
    expect(edges.total).toBeGreaterThan(1)
    expect(edges.edges).toHaveLength(1)
    expect(edges.nextCursor).not.toBeNull()
    expect((await page('edges', edges.nextCursor!, 1)).edges).toHaveLength(1)
  })

  it('refuses page scans above the configured node limit', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault, ['    pageScanNodesLimit: 2'])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('page-scan-limit'),
      name: 'wiki_graph_page', arguments: { kind: 'edges' },
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected bounded graph scan failure')
    expect(result.error.message).toContain('pageScanNodesLimit')
  })

  it('refuses page scans above the configured edge limit without blocking the compact audit', async () => {
    const vault = await makeKeywordVault()
    const ctx = await boot(vault, ['    pageScanEdgesLimit: 1'])
    const page = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('page-edge-scan-limit'),
      name: 'wiki_graph_page', arguments: { kind: 'edges' },
    })
    expect(page.isError).toBe(true)
    if (!page.isError) throw new Error('expected bounded edge scan failure')
    expect(page.error.message).toContain('pageScanEdgesLimit')
    const audit = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('page-limit-audit'),
      name: 'wiki_graph_audit', arguments: {},
    })
    expect(audit.isError).toBe(false)
    if (audit.isError) throw new Error(audit.error.message)
    expect(JSON.parse(resultText(audit))).toMatchObject({ complete: true, archiveExcluded: true })
  })

  it('reports archive inclusion instead of claiming isolation when exclusions are disabled', async () => {
    const vault = await makeVault()
    await mkdir(join(vault, 'archive'))
    await writeFile(join(vault, 'archive', 'memory.md'), '# Embedding\n\nRAG embedding memory.\n')
    const ctx = await boot(vault, ['    excludeDirs: []'])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('archive-included-audit'),
      name: 'wiki_graph_audit', arguments: {},
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error(result.error.message)
    expect(JSON.parse(resultText(result))).toMatchObject({
      indexedNodes: 4, excludedDirsApplied: [], archiveNodesInIndex: 1,
      complete: true, archiveExcluded: false,
    })
  })

  it('clamps a requested depth to maxDepthLimit and reports the effective depth', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-graph-vault-'))
    await writeFile(join(vault, 'center.md'), '# Center\n\nSee [[zeta]].\n')
    await writeFile(join(vault, 'zeta.md'), '# Zeta\n\nSee [[alpha]].\n')
    await writeFile(join(vault, 'alpha.md'), '# Alpha\n')
    const ctx = await boot(vault, ['    maxDepthLimit: 2'])

    // Under the limit the request is honored as asked.
    const honored = await graphFrom(ctx, 'graph-depth-honored', 'center.md', 2)
    expect(honored.depth).toBe(2)
    expect(honored.nodes.map(node => node.id).sort()).toEqual(['alpha.md', 'center.md', 'zeta.md'])

    // Past the limit the traversal stops at the cap, and the result says so
    // instead of silently claiming the requested depth.
    const clamped = await graphFrom(ctx, 'graph-depth-clamped', 'center.md', 9)
    expect(clamped.depth).toBe(2)
    expect(clamped.nodes.map(node => node.id).sort()).toEqual(['alpha.md', 'center.md', 'zeta.md'])
  })

  it('clamps the default depth to maxDepthLimit too', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-graph-vault-'))
    await writeFile(join(vault, 'center.md'), '# Center\n\nSee [[zeta]].\n')
    await writeFile(join(vault, 'zeta.md'), '# Zeta\n\nSee [[alpha]].\n')
    await writeFile(join(vault, 'alpha.md'), '# Alpha\n')
    // One hop is reachable, but the configured default asks for more: the cap
    // keeps the walk at one level and reports that effective depth.
    const ctx = await boot(vault, ['    maxDepthLimit: 1'])

    const graph = await graphFrom(ctx, 'graph-depth-default-clamp', 'center.md', 3)
    expect(graph.depth).toBe(1)
    expect(graph.nodes.map(node => node.id).sort()).toEqual(['center.md', 'zeta.md'])
  })

  it('refuses nonpositive per-call budgets', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    for (const args of [{ maxNodes: 0 }, { maxEdges: 0 }]) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`invalid-budget-${Object.keys(args)[0]}`),
        name: 'wiki_graph', arguments: args,
      })
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('expected invalid budget to fail')
      expect(result.error.message).toContain('must be a positive integer')
    }
  })

  it('refuses to register wiki_graph with an invalid hard edge limit', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault, ['    maxEdgesLimit: 0'])
    expect(ctx.tools.schemas().some(schema => schema.name === 'wiki_graph')).toBe(false)
  })

  it('refuses to register wiki_graph when maxDepthLimit is below maxDepth', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault, ['    maxDepth: 3', '    maxDepthLimit: 2'])
    expect(ctx.tools.schemas().some(schema => schema.name === 'wiki_graph')).toBe(false)
  })

  it('refuses to register wiki_graph when extensions is an empty list', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault, ['    extensions: []'])
    expect(ctx.tools.schemas().some(schema => schema.name === 'wiki_graph')).toBe(false)
  })
})
