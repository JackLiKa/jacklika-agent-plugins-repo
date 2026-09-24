import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
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
import * as ToolMemoryVector from '@jacklika/dsh-tool-memory-vector'

let root: string | undefined
let context: Context | undefined
let server: Server | undefined
let requestCount = 0

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => { resolve() }))
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  requestCount = 0
})

const VOCAB = ['rag', 'cook'] as const

/** Deterministic embedding: count occurrences of each vocabulary term. */
function embeddingOf(text: string): number[] {
  const lower = text.toLowerCase()
  return VOCAB.map(term => lower.split(term).length - 1)
}

/** Start a fake OpenAI-compatible embeddings endpoint on an ephemeral port. */
async function fakeEmbeddingsEndpoint(): Promise<string> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      requestCount += 1
      const parsed = JSON.parse(body) as { input: string[] }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: inputs.map(text => ({ embedding: embeddingOf(text) })) }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}/v1/embeddings`
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the vector memory tool and a fake endpoint.
 * @param vaultRoot - absolute path to the vault root.
 * @param endpoint - fake embeddings endpoint URL.
 * @returns the booted context.
 */
async function boot(vaultRoot: string, endpoint: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-vector-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-tool-memory-vector'",
    '  config:',
    `    vaultRoot: ${vaultRoot}`,
    `    endpoint: ${endpoint}`,
    '    model: fake-embed',
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
    ['@jacklika/dsh-tool-memory-vector', ToolMemoryVector],
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
  const vaultRoot = await mkdtemp(join(tmpdir(), 'dsh-vector-vault-'))
  const concepts = join(vaultRoot, 'concepts')
  await mkdir(concepts)
  await writeFile(join(concepts, 'RAG.md'), '# Retrieval-Augmented Generation\n\nRAG combines retrieval with LLM generation.\n')
  await writeFile(join(vaultRoot, 'island.md'), '# Cooking notes\n\nHow to cook rice.\n')
  return vaultRoot
}

describe('tool-memory-vector real Loader composition through cordis.yml', () => {
  it('exposes the wiki_semantic_search tool', async () => {
    const endpoint = await fakeEmbeddingsEndpoint()
    const vault = await makeVault()
    const ctx = await boot(vault, endpoint)
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('wiki_semantic_search')
  })

  it('ranks notes by embedding similarity and caches embeddings across calls', async () => {
    const endpoint = await fakeEmbeddingsEndpoint()
    const vault = await makeVault()
    const ctx = await boot(vault, endpoint)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('semantic-rag'),
      name: 'wiki_semantic_search',
      arguments: { query: 'rag retrieval augmented' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_semantic_search success')
    const hits = JSON.parse(resultText(result)) as { id: string; score: number }[]
    expect(hits[0]?.id).toBe('concepts/RAG.md')
    expect(hits[0]!.score).toBeGreaterThan(hits[1]?.score ?? 0)

    const indexText = await readFile(join(vault, '.vector-index.json'), 'utf8')
    expect(indexText).toContain('concepts/RAG.md')

    const callsBefore = requestCount
    const second = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('semantic-rag-2'),
      name: 'wiki_semantic_search',
      arguments: { query: 'rag retrieval augmented' },
    })
    expect(second.isError).toBe(false)
    // Only the query embedding is requested; note embeddings are cached by mtime.
    expect(requestCount).toBe(callsBefore + 1)
  })
})
