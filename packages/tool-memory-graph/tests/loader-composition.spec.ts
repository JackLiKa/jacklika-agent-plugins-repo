import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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
  const concepts = join(vaultRoot, 'concepts')
  await mkdir(concepts)
  await writeFile(join(concepts, 'RAG.md'), '# Retrieval-Augmented Generation\n\nRAG combines [[embedding]] retrieval with LLM generation.\n')
  await writeFile(join(vaultRoot, 'embedding.md'), '# Embedding\n\nAn embedding is a dense vector. See also [[concepts/RAG]].\n')
  await writeFile(join(vaultRoot, 'island.md'), '# Island\n\nNo links here.\n')
  return vaultRoot
}

/** The parsed `wiki_graph` payload. */
interface Graph {
  nodes: { id: string; title: string }[]
  edges: { from: string; to: string }[]
  truncated: boolean
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
  })

  it('withdraws wiki_graph when its Loader fiber unloads', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const tools = ctx.tools
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-tool-memory-graph')
    if (entry?.fiber === undefined) throw new Error('active graph entry missing')
    await entry.fiber.dispose()
    expect(tools.schemas().some(schema => schema.name === 'wiki_graph')).toBe(false)
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
    }
    expect(graph.nodes.map(n => n.id).sort()).toEqual(['concepts/RAG.md', 'embedding.md', 'island.md'])
    expect(graph.nodes.find(n => n.id === 'concepts/RAG.md')?.title).toBe('Retrieval-Augmented Generation')
    expect(graph.edges).toContainEqual({ from: 'concepts/RAG.md', to: 'embedding.md' })
    expect(graph.edges).toContainEqual({ from: 'embedding.md', to: 'concepts/RAG.md' })
    expect(graph.truncated).toBe(false)
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
    for (const edge of graph.edges) {
      expect(graph.nodes.some(node => node.id === edge.from)).toBe(true)
      expect(graph.nodes.some(node => node.id === edge.to)).toBe(true)
    }
  })
})
