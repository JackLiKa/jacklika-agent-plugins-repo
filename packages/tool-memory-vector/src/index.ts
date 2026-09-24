/**
 * Model-facing semantic search over a Markdown memory vault. The package
 * registers `wiki_semantic_search`, which embeds notes through a configurable
 * OpenAI-compatible embeddings endpoint and ranks them by cosine similarity.
 * Embeddings are cached per note under `<vault>/.vector-index.json`, keyed by
 * file mtime so unchanged notes are not re-embedded.
 * @module @jacklika/dsh-tool-memory-vector
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { listNotePaths, resolveMemoryVaultRoot } from '@jacklika/dsh-tool-memory-filesystem'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory-vector'

/** Services required by the semantic search tool. */
export const inject = ['tools']

/** File storing the per-vault embedding cache. */
const INDEX_FILE = '.vector-index.json'

/** Plugin configuration. */
export interface Config {
  /**
   * Explicit vault root. When omitted, each tool call resolves the memory
   * directory under the calling session's workspace (`<cwd>/.dsh/memory/`).
   * A relative path is resolved against the session workspace.
   */
  vaultRoot?: string
  /** File extensions to treat as notes. */
  extensions?: string[]
  /** OpenAI-compatible embeddings endpoint (e.g. `http://localhost:11434/v1/embeddings`). */
  endpoint: string
  /** Embedding model name understood by the endpoint (e.g. `nomic-embed-text`). */
  model: string
  /** Optional bearer token sent to the embeddings endpoint. */
  apiKey?: string
  /** Maximum search hits to return. */
  maxResults?: number
  /** Maximum UTF-8 characters of one note sent to the embeddings endpoint. */
  maxCharsPerNote?: number
  /** Maximum inputs per embeddings request. */
  batchSize?: number
  /** Descend into dot-directories besides the fixed exclusions while indexing. */
  indexHiddenDirs?: boolean
}

/** Schemastery configuration for the semantic memory tool consumer. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().default(''),
  extensions: z.array(z.string()).default(['.md']),
  endpoint: z.string(),
  model: z.string(),
  apiKey: z.string().default(''),
  maxResults: z.number().default(10),
  maxCharsPerNote: z.number().default(8000),
  batchSize: z.number().default(16),
  indexHiddenDirs: z.boolean().default(false),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** One cached embedding keyed by note mtime. */
interface IndexEntry {
  mtimeMs: number
  embedding: number[]
}

/** The on-disk index: vault-relative note id to its embedding record. */
type VectorIndex = Record<string, IndexEntry>

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-memory-vector: ${name} must be a positive integer`)
  }
}

/**
 * Call the embeddings endpoint for a batch of inputs.
 * @param resolved - applied plugin configuration.
 * @param inputs - note texts or the query text.
 * @returns one embedding vector per input.
 */
async function embed(resolved: ResolvedConfig, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return []
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (resolved.apiKey !== '') headers.authorization = `Bearer ${resolved.apiKey}`
  const response = await fetch(resolved.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: resolved.model, input: inputs }),
  })
  if (!response.ok) {
    throw new Error(`tool-memory-vector: embeddings endpoint returned ${response.status}`)
  }
  const payload = await response.json() as { data?: { embedding?: number[] }[] }
  const data = payload.data
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new Error('tool-memory-vector: embeddings endpoint returned a mismatched data array')
  }
  return data.map((entry) => {
    const vector = entry.embedding
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('tool-memory-vector: embeddings endpoint returned an empty vector')
    }
    return vector
  })
}

/** Cosine similarity between two equal-length vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

async function loadIndex(root: string): Promise<VectorIndex> {
  try {
    const text = await readFile(join(root, INDEX_FILE), 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as VectorIndex
  } catch {
    return {}
  }
}

/**
 * Refresh the embedding index for the current vault contents: embed every
 * note whose file is new or whose mtime changed since the cached record, drop
 * deleted notes, and persist the result.
 * @param root - vault root.
 * @param resolved - applied plugin configuration.
 * @returns the up-to-date index.
 */
async function refreshIndex(root: string, resolved: ResolvedConfig): Promise<VectorIndex> {
  const paths = await listNotePaths(root, resolved.extensions, resolved.indexHiddenDirs)
  const loaded = await loadIndex(root)
  const alive = new Set(paths.map(path => relative(root, path)))

  let removed = 0
  const index: VectorIndex = {}
  for (const [id, entry] of Object.entries(loaded)) {
    if (alive.has(id)) {
      index[id] = entry
    } else {
      removed += 1
    }
  }

  const stale: { id: string; text: string }[] = []
  for (const path of paths) {
    const id = relative(root, path)
    const info = await stat(path)
    if (index[id]?.mtimeMs === info.mtimeMs) continue
    const text = await readFile(path, 'utf8')
    stale.push({ id, text: text.slice(0, resolved.maxCharsPerNote) })
  }

  for (let i = 0; i < stale.length; i += resolved.batchSize) {
    const batch = stale.slice(i, i + resolved.batchSize)
    const vectors = await embed(resolved, batch.map(item => item.text))
    const stats = await Promise.all(batch.map(item => stat(join(root, item.id))))
    batch.forEach((item, offset) => {
      const info = stats[offset]
      const embedding = vectors[offset]
      if (info === undefined || embedding === undefined) {
        throw new Error('tool-memory-vector: index refresh lost track of a note')
      }
      index[item.id] = { mtimeMs: info.mtimeMs, embedding }
    })
  }

  if (stale.length > 0 || removed > 0) {
    await writeFile(join(root, INDEX_FILE), JSON.stringify(index), 'utf8')
  }
  return index
}

/**
 * Register the `wiki_semantic_search` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit search configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.endpoint.trim() === '') {
    throw new Error('tool-memory-vector: endpoint is required')
  }
  if (resolved.model.trim() === '') {
    throw new Error('tool-memory-vector: model is required')
  }
  assertPositiveInteger('maxResults', resolved.maxResults)
  assertPositiveInteger('maxCharsPerNote', resolved.maxCharsPerNote)
  assertPositiveInteger('batchSize', resolved.batchSize)

  ctx.tools.register(defineTool({
    name: 'wiki_semantic_search',
    description: 'Semantic search over the wiki vault using embeddings: ranks notes by meaning rather than exact keywords. Returns matching note ids with similarity scores. Use wiki_search for exact keyword lookups.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Natural-language description of the note content to find.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            score: { type: 'number' },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = resolveMemoryVaultRoot(resolved.vaultRoot, exec)
      const index = await refreshIndex(vaultRoot, resolved)
      const [queryVector] = await embed(resolved, [args.query])
      if (queryVector === undefined) {
        throw new Error('tool-memory-vector: embeddings endpoint returned no query vector')
      }
      const hits = Object.entries(index)
        .map(([id, entry]) => ({ id, score: cosine(queryVector, entry.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, resolved.maxResults)
      return hits
    },
  }))
}
