/**
 * Model-facing link-graph tool over a Markdown memory vault. The package
 * registers `wiki_graph`, which returns the vault's note/link graph or the
 * subgraph reachable from one note, so an agent can reason about how memory
 * notes connect before reading them.
 *
 * In addition to explicit Obsidian-style `[[link]]` edges, `wiki_graph` now
 * derives keyword edges: two notes share a directed keyword edge for every
 * significant term that appears in both. Rewriting a note therefore
 * automatically removes stale keyword edges and creates new ones for the terms
 * that survive or appear in the new text.
 * @module @jacklika/dsh-tool-memory-graph
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  codeUnitCompare, containedPathReal, createLinkResolver, extractLinks, listNotePaths, resolveLinkTarget, resolveMemoryVaultRoot, splitFrontmatter, vaultRelativeId,
} from '@jacklika/dsh-tool-memory-filesystem'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory-graph'

/** Services required by the wiki graph tool. */
export const inject = ['tools']

/** Plugin configuration, mirroring the filesystem memory vault settings. */
export interface Config {
  /**
   * Explicit vault root. When omitted, each tool call resolves the memory
   * directory under the calling session's workspace (`<cwd>/.dsh/memory/`).
   * A relative path is resolved against the session workspace.
   */
  vaultRoot?: string
  /** File extensions to treat as notes. */
  extensions?: string[]
  /** Default traversal depth when the call omits `depth`. */
  maxDepth?: number
  /**
   * Hard upper bound for the effective depth. A call asking for more is
   * clamped to this value, and the subgraph reports the depth actually
   * traversed. Must be greater than or equal to `maxDepth`.
   */
  maxDepthLimit?: number
  /** Maximum nodes returned in one graph. */
  maxNodes?: number
  /** Maximum edges returned in one graph. */
  maxEdges?: number
  /** Descend into dot-directories besides the fixed exclusions while indexing. */
  indexHiddenDirs?: boolean
  excludeDirs?: string[]
}

/** Schemastery configuration for the memory graph tool consumer. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().default(''),
  extensions: z.array(z.string()).default(['.md']),
  maxDepth: z.number().default(1),
  maxDepthLimit: z.number().default(20),
  maxNodes: z.number().default(200),
  maxEdges: z.number().default(1000),
  indexHiddenDirs: z.boolean().default(false),
  excludeDirs: z.array(z.string()).default(['archive']),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** One note in the link graph. */
interface GraphNode {
  /** Vault-relative note id. */
  id: string
  /** First heading or basename without extension. */
  title: string
}

/** One directed `[[link]]` or keyword edge between notes. */
interface GraphEdge {
  /** Source note id. */
  from: string
  /** Target note id. */
  to: string
  /** Edge type: explicit `link` or derived `keyword`. */
  type?: 'link' | 'keyword'
  /** Shared keywords for `type: 'keyword'` edges. */
  keywords?: string[]
  /** Combined term frequency weight for `type: 'keyword'` edges. */
  weight?: number
}

/** The complete or partial link graph returned by `wiki_graph`. */
interface MemoryGraph {
  /** Notes in the returned graph, capped at `maxNodes`. */
  nodes: GraphNode[]
  /** Resolved links between returned nodes. */
  edges: GraphEdge[]
  /** Whether `maxNodes` truncated the node set. */
  truncated: boolean
  /** Whether `maxEdges` truncated the edge set. */
  edgesTruncated: boolean
  /** Depth actually traversed, after clamping to `maxDepthLimit`; present on subgraph results. */
  depth?: number
}

interface ParsedNote {
  id: string
  path: string
  text: string
  terms: Map<string, number>
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-memory-graph: ${name} must be a positive integer`)
  }
}

/**
 * Minimal English stopwords. The list is intentionally short; the model-facing
 * graph is most useful for distinctive project terms, not for hiding grammar.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'may', 'might',
  'can', 'could', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'me', 'my', 'you', 'your', 'we', 'us', 'our', 'he', 'him',
  'his', 'she', 'her', 'they', 'them', 'their', 'not', 'no', 'if', 'then', 'than', 'so', 'very',
  'just', 'only', 'also', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'what', 'which', 'who', 'whom', 'whose', 'see', 'one', 'two', 'three', 'four', 'five',
  'get', 'got', 'go', 'went', 'come', 'came', 'take', 'took', 'make', 'made', 'know', 'knew',
  'think', 'thought', 'say', 'said', 'look', 'use', 'used', 'find', 'found', 'give', 'gave',
  'tell', 'told', 'ask', 'asked', 'work', 'worked', 'seem', 'seemed', 'feel', 'felt', 'try',
  'tried', 'leave', 'left', 'call', 'called', 'keep', 'kept', 'let', 'put', 'bring', 'brought',
  'begin', 'began', 'help', 'helped', 'show', 'showed', 'hear', 'heard', 'play', 'played', 'run',
  'ran', 'move', 'moved', 'live', 'lived', 'believe', 'believed', 'hold', 'held', 'must', 'need',
  'needed', 'able', 'due', 'while', 'whereas', 'nevertheless', 'however', 'therefore', 'moreover',
  'furthermore', 'nonetheless', 'otherwise', 'meanwhile', 'besides', 'thus', 'hence', 'accordingly',
  'consequently', 'now', 'later', 'soon', 'early', 'late', 'long', 'much', 'many', 'little', 'less',
  'least', 'well', 'better', 'best', 'bad', 'worse', 'worst', 'good', 'great', 'new', 'old',
  'first', 'last', 'next', 'previous', 'same', 'different', 'own', 'another', 'none', 'either',
  'neither', 'whether', 'nor', 'even', 'still', 'yet', 'already', 'always', 'never', 'often',
  'sometimes', 'usually', 'rarely', 'seldom', 'back', 'already', 'quite', 'rather', 'really',
  'actually', 'certainly', 'definitely', 'probably', 'possibly', 'perhaps', 'maybe', 'likely',
  'sure', 'course', 'absolutely', 'completely', 'entirely', 'totally', 'almost', 'nearly',
  'hardly', 'barely', 'scarcely', 'enough',
])

/** Token pattern: starts with a letter, then letters or digits. Unicode-aware. */
const TOKEN_RE = /[\p{L}][\p{L}\p{N}]*/gu

/**
 * Extract normalised significant terms from Markdown text.
 * - Frontmatter `tags` count 3x (they are explicit metadata).
 * - Frontmatter `title` counts 2x.
 * - Body terms count 1x.
 * - Numbers-only tokens and short/stop tokens are dropped.
 */
function extractTerms(text: string): Map<string, number> {
  const { frontmatter, body } = splitFrontmatter(text)
  const terms = new Map<string, number>()

  const addToken = (raw: string, multiplier = 1): void => {
    const normalized = raw.normalize('NFC').toLowerCase()
    if (normalized.length < 2) return
    if (/^\d+$/.test(normalized)) return
    if (STOPWORDS.has(normalized)) return
    terms.set(normalized, (terms.get(normalized) ?? 0) + multiplier)
  }

  const tokenize = (source: string): string[] => {
    const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags)
    return source.match(re) ?? []
  }

  if (Array.isArray(frontmatter.tags)) {
    for (const tag of frontmatter.tags) {
      if (typeof tag === 'string') {
        for (const token of tokenize(tag)) addToken(token, 3)
      }
    }
  }

  if (typeof frontmatter.title === 'string') {
    for (const token of tokenize(frontmatter.title)) addToken(token, 2)
  }

  // Strip Obsidian `[[link]]` syntax so explicit links do not also create
  // redundant keyword edges; keep markdown link text, not the URL.
  const bodyForTerms = body
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  for (const token of tokenize(bodyForTerms)) addToken(token, 1)

  return terms
}

function noteTitleFromText(text: string, id: string): string {
  const { frontmatter, body } = splitFrontmatter(text)
  const explicitTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : ''
  if (explicitTitle !== '') return explicitTitle
  const heading = /^#\s+(.+)$/m.exec(body)
  return heading?.[1]?.trim() ?? id.replace(/\.[^.]+$/, '')
}

/**
 * Build undirected keyword edges for a set of notes. Each pair of notes that
 * share one or more terms receives two directed edges (A→B and B→A) carrying
 * the sorted shared keywords and a combined weight.
 */
function buildKeywordEdges(noteTerms: Map<string, Map<string, number>>): GraphEdge[] {
  const inverted = new Map<string, string[]>()
  for (const [id, terms] of noteTerms) {
    for (const term of terms.keys()) {
      const list = inverted.get(term) ?? []
      list.push(id)
      inverted.set(term, list)
    }
  }

  const pairData = new Map<string, { keywords: string[]; weight: number }>()
  for (const [term, ids] of inverted) {
    if (ids.length < 2) continue
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!
        const b = ids[j]!
        const [first, second] = codeUnitCompare(a, b) <= 0 ? [a, b] : [b, a]
        const weight = (noteTerms.get(a)?.get(term) ?? 0) + (noteTerms.get(b)?.get(term) ?? 0)
        const key = `${first}\x00${second}`
        const entry = pairData.get(key) ?? { keywords: [], weight: 0 }
        entry.keywords.push(term)
        entry.weight += weight
        pairData.set(key, entry)
      }
    }
  }

  const edges: GraphEdge[] = []
  for (const [key, { keywords, weight }] of pairData) {
    const parts = key.split('\x00')
    const from = parts[0]!
    const to = parts[1]!
    const sortedKeywords = [...keywords].sort(codeUnitCompare)
    edges.push({ from, to, type: 'keyword', keywords: sortedKeywords, weight })
    edges.push({ from: to, to: from, type: 'keyword', keywords: sortedKeywords, weight })
  }
  return edges
}

async function loadVaultNotes(
  root: string,
  resolved: ResolvedConfig,
  onSkip?: (path: string, error: unknown) => void,
): Promise<{
  parsed: ParsedNote[]
  parsedById: Map<string, ParsedNote>
  linkResolver: ReturnType<typeof createLinkResolver>
  skipped: Map<string, unknown>
}> {
  const paths = await listNotePaths(root, resolved.extensions, resolved.indexHiddenDirs, onSkip, resolved.excludeDirs)
  const ids = paths.map(path => vaultRelativeId(root, path))
  const linkResolver = createLinkResolver(ids)
  const parsed: ParsedNote[] = []
  const parsedById = new Map<string, ParsedNote>()
  const skipped = new Map<string, unknown>()
  for (const path of paths) {
    const id = vaultRelativeId(root, path)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // One unreadable note must not fail the graph for the whole vault; the
      // note is omitted and the loader logs the degradation.
      skipped.set(id, error)
      onSkip?.(path, error)
      continue
    }
    const note: ParsedNote = { id, path, text, terms: extractTerms(text) }
    parsed.push(note)
    parsedById.set(id, note)
  }
  return { parsed, parsedById, linkResolver, skipped }
}

/** Build the skip callback that reports unreadable entries to the Loader logger. */
function skipLogger(ctx: Context, root: string): (path: string, error: unknown) => void {
  return (path, error) => {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    ctx.logger?.warn(`tool-memory-graph: skipped unreadable entry ${vaultRelativeId(root, path)} (${code})`)
  }
}

/** Validate that at least one note extension is configured. */
function assertExtensions(extensions: string[]): void {
  if (extensions.length === 0) {
    throw new Error('tool-memory-graph: extensions must list at least one file extension')
  }
}

/**
 * Apply the edge budget deterministically: explicit `link` edges are kept
 * first, then `keyword` edges by descending weight and id order, so the same
 * vault returns the same subset regardless of directory-listing order. Below
 * the budget the edge list is returned untouched.
 */
function capEdges(edges: GraphEdge[], maxEdges: number): { edges: GraphEdge[]; truncated: boolean } {
  if (edges.length <= maxEdges) return { edges, truncated: false }
  const ordered = [...edges].sort((a, b) => {
    const linkFirst = (a.type === 'keyword' ? 1 : 0) - (b.type === 'keyword' ? 1 : 0)
    if (linkFirst !== 0) return linkFirst
    const weightOrder = (b.weight ?? 0) - (a.weight ?? 0)
    if (weightOrder !== 0) return weightOrder
    return codeUnitCompare(a.from, b.from) || codeUnitCompare(a.to, b.to)
  })
  return { edges: ordered.slice(0, maxEdges), truncated: true }
}

/**
 * Build the vault-wide link graph: every note is a node; every `[[link]]`
 * that resolves to an existing note is an edge; every shared significant term
 * between two nodes becomes a directed `keyword` edge in both directions.
 * @param root - vault root.
 * @param resolved - applied plugin configuration.
 * @returns the full graph, node-capped.
 */
async function buildGraph(
  root: string,
  resolved: ResolvedConfig,
  onSkip?: (path: string, error: unknown) => void,
): Promise<MemoryGraph> {
  const { parsed, linkResolver } = await loadVaultNotes(root, resolved, onSkip)

  const truncated = parsed.length > resolved.maxNodes
  const capped = [...parsed].sort((a, b) => codeUnitCompare(a.id, b.id)).slice(0, resolved.maxNodes)
  const idSet = new Set(capped.map(p => p.id))

  const nodes: GraphNode[] = capped.map(p => ({ id: p.id, title: noteTitleFromText(p.text, p.id) }))
  const edges: GraphEdge[] = []

  for (const p of capped) {
    for (const link of extractLinks(p.text)) {
      const targetPath = await resolveLinkTarget(root, resolved.extensions, link, linkResolver)
      if (targetPath === undefined) continue
      const targetId = vaultRelativeId(root, targetPath)
      if (idSet.has(targetId)) edges.push({ from: p.id, to: targetId })
    }
  }

  const noteTerms = new Map(capped.map(p => [p.id, p.terms]))
  edges.push(...buildKeywordEdges(noteTerms))

  // Safety: every edge endpoint must be in the returned node set.
  const safeEdges = edges.filter(e => idSet.has(e.from) && idSet.has(e.to))
  const budgeted = capEdges(safeEdges, resolved.maxEdges)
  return { nodes, edges: budgeted.edges, truncated, edgesTruncated: budgeted.truncated }
}

/**
 * Collect the subgraph reachable from one note by following `[[link]]`
 * references and shared-keyword edges breadth-first up to `depth`.
 * @param root - vault root.
 * @param resolved - applied plugin configuration.
 * @param startId - vault-relative id of the center note.
 * @param depth - maximum link/keyword hops from the center.
 * @returns the neighborhood graph, node-capped.
 */
async function buildSubgraph(
  root: string,
  resolved: ResolvedConfig,
  startId: string,
  depth: number,
  onSkip?: (path: string, error: unknown) => void,
): Promise<MemoryGraph> {
  const { parsed, parsedById, linkResolver, skipped } = await loadVaultNotes(root, resolved, onSkip)
  const startPath = await containedPathReal(root, startId)
  const startNoteId = vaultRelativeId(root, startPath)
  // A missing path, a directory, or a file outside the configured extensions
  // resolves fine but has no indexed note; seeding the BFS with it would crash
  // on the first `parsedById.get(id)!` lookup.
  if (!parsedById.has(startNoteId)) {
    const skipError = skipped.get(startNoteId)
    if (skipError !== undefined) {
      const code = (skipError as NodeJS.ErrnoException).code ?? 'unknown error'
      throw new Error(`tool-memory-graph: cannot read note ${JSON.stringify(startNoteId)}: ${code}`)
    }
    throw new Error(`tool-memory-graph: note not found: ${startNoteId}`)
  }

  const idSetAll = new Set(parsed.map(p => p.id))
  const adjacency = new Map<string, string[]>()

  for (const p of parsed) {
    const neighbors: string[] = []
    for (const link of extractLinks(p.text)) {
      const targetPath = await resolveLinkTarget(root, resolved.extensions, link, linkResolver)
      if (targetPath === undefined) continue
      const targetId = vaultRelativeId(root, targetPath)
      if (idSetAll.has(targetId) && !neighbors.includes(targetId)) neighbors.push(targetId)
    }
    adjacency.set(p.id, neighbors)
  }

  const noteTerms = new Map(parsed.map(p => [p.id, p.terms]))
  const keywordEdges = buildKeywordEdges(noteTerms)
  for (const { from, to } of keywordEdges) {
    const list = adjacency.get(from) ?? []
    if (!list.includes(to)) list.push(to)
    adjacency.set(from, list)
  }

  const visited = new Map<string, number>([[startNoteId, 0]])
  let frontier = [startNoteId]
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.set(neighbor, level + 1)
          next.push(neighbor)
        }
      }
    }
    frontier = next
  }

  const truncated = visited.size > resolved.maxNodes
  const ids = [...visited.keys()]
    .sort((a, b) => (visited.get(a) ?? 0) - (visited.get(b) ?? 0) || codeUnitCompare(a, b))
    .slice(0, resolved.maxNodes)
  const idSet = new Set(ids)

  const nodes: GraphNode[] = ids.map(id => {
    const p = parsedById.get(id)!
    return { id, title: noteTitleFromText(p.text, id) }
  })

  const edges: GraphEdge[] = []
  for (const id of ids) {
    const p = parsedById.get(id)!
    for (const link of extractLinks(p.text)) {
      const targetPath = await resolveLinkTarget(root, resolved.extensions, link, linkResolver)
      if (targetPath === undefined) continue
      const toId = vaultRelativeId(root, targetPath)
      if (idSet.has(toId)) edges.push({ from: id, to: toId })
    }
  }

  const filteredKeywordEdges = keywordEdges.filter(e => idSet.has(e.from) && idSet.has(e.to))
  edges.push(...filteredKeywordEdges)

  const budgeted = capEdges(edges, resolved.maxEdges)
  return { nodes, edges: budgeted.edges, truncated, edgesTruncated: budgeted.truncated, depth }
}

/**
 * Register the `wiki_graph` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.get('tools') as { register?: unknown } | undefined
  if (typeof tools?.register !== 'function') {
    ctx.logger?.warn('tool-memory-graph: ctx.tools.register unavailable; wiki_graph tool will not register.')
    return
  }

  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxDepth', resolved.maxDepth)
  assertPositiveInteger('maxDepthLimit', resolved.maxDepthLimit)
  if (resolved.maxDepthLimit < resolved.maxDepth) {
    throw new Error('tool-memory-graph: maxDepthLimit must be >= maxDepth')
  }
  assertPositiveInteger('maxNodes', resolved.maxNodes)
  assertPositiveInteger('maxEdges', resolved.maxEdges)
  assertExtensions(resolved.extensions)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_graph',
    description: 'Return the link and keyword graph of the wiki vault: note ids, titles, and directed edges. Explicit `[[link]]` edges are type `link`; edges derived from shared significant terms are type `keyword` with `keywords` and `weight`. Without an id it returns the whole vault graph (node-capped); with an id it returns the subgraph reachable from that note within the given depth. Nodes are capped at maxNodes (`truncated`) and edges at maxEdges (`edgesTruncated`); a subgraph result also reports the effective `depth` after clamping the request to maxDepthLimit.',
    parameters: {
      id: {
        type: 'string',
        description: 'Optional vault-relative note id to center the subgraph on (e.g. "concepts/RAG.md").',
      },
      depth: {
        type: 'integer',
        description: 'Maximum link or keyword hops from the center note; defaults to the configured maxDepth and is capped at the configured maxDepthLimit.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = resolveMemoryVaultRoot(resolved.vaultRoot, exec)
      const requestedDepth = args.depth ?? resolved.maxDepth
      assertPositiveInteger('depth', requestedDepth)
      const depth = Math.min(requestedDepth, resolved.maxDepthLimit)
      const onSkip = skipLogger(ctx, vaultRoot)
      const graph = args.id === undefined
        ? await buildGraph(vaultRoot, resolved, onSkip)
        : await buildSubgraph(vaultRoot, resolved, args.id, depth, onSkip)
      return graph as unknown as JsonValue
    },
  })))
}
