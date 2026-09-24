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
async function boot(vaultRoot: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-graph-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-tool-memory-graph'",
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

describe('tool-memory-graph real Loader composition through cordis.yml', () => {
  it('exposes the wiki_graph tool', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('wiki_graph')
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
})
