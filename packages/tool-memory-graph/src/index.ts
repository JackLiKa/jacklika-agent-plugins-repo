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

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
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
  maxNodesLimit?: number
  /** Maximum edges returned in one graph. */
  maxEdges?: number
  maxEdgesLimit?: number
  pageSizeLimit?: number
  pageScanNodesLimit?: number
  pageScanEdgesLimit?: number
  /** Descend into dot-directories besides the fixed exclusions while indexing. */
  indexHiddenDirs?: boolean
  excludeDirs?: string[]
  /**
   * Drop keyword terms shared by more than this fraction of indexed notes.
   * Terms above the document-frequency ceiling carry no discriminating signal
   * (a word in every note connects everything to everything). `1` keeps every
   * term — the historical behavior.
   */
  keywordMaxDocFraction?: number
  /**
   * Keep at most this many keyword edges per note, dropping weaker pairs.
   * A pair survives only when both endpoints rank it inside their own top K
   * (mutual nearest neighbors), so asymmetric weights cannot orphan a pair.
   * `0` disables pruning — the historical behavior.
   */
  keywordEdgeTopK?: number
}

/** Schemastery configuration for the memory graph tool consumer. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().default(''),
  extensions: z.array(z.string()).default(['.md']),
  maxDepth: z.number().default(1),
  maxDepthLimit: z.number().default(20),
  maxNodes: z.number().default(200),
  maxNodesLimit: z.number().default(2000),
  maxEdges: z.number().default(1000),
  maxEdgesLimit: z.number().default(20000),
  pageSizeLimit: z.number().default(250),
  pageScanNodesLimit: z.number().default(5000),
  pageScanEdgesLimit: z.number().default(250000),
  indexHiddenDirs: z.boolean().default(false),
  excludeDirs: z.array(z.string()).default(['archive']),
  keywordMaxDocFraction: z.number().min(0).max(1).default(1),
  keywordEdgeTopK: z.number().min(0).default(0),
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
  nodesTotal: number
  nodesReturned: number
  edgesTotal: number
  edgesReturned: number
  edgesDropped: number
  effectiveMaxNodes: number
  effectiveMaxEdges: number
  excludedDirs: string[]
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
interface KeywordSparsify {
  /** Document-frequency ceiling in (0, 1]; `1` disables the filter. */
  maxDocFraction: number
  /** Mutual top-K keyword edges per node; `0` disables pruning. */
  topK: number
}

function buildKeywordEdges(noteTerms: Map<string, Map<string, number>>, maxPairs?: number, sparsify?: KeywordSparsify): GraphEdge[] {
  const noteCount = noteTerms.size
  const docCeiling = sparsify !== undefined && sparsify.maxDocFraction < 1
    ? sparsify.maxDocFraction * noteCount
    : Number.POSITIVE_INFINITY
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
    if (ids.length < 2 || ids.length > docCeiling) continue
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!
        const b = ids[j]!
        const [first, second] = codeUnitCompare(a, b) <= 0 ? [a, b] : [b, a]
        const weight = (noteTerms.get(a)?.get(term) ?? 0) + (noteTerms.get(b)?.get(term) ?? 0)
        const key = `${first}\x00${second}`
        const existing = pairData.get(key)
        if (existing === undefined && maxPairs !== undefined && pairData.size >= maxPairs) {
          throw new Error('tool-memory-graph: graph page scan exceeds pageScanEdgesLimit')
        }
        const entry = existing ?? { keywords: [], weight: 0 }
        entry.keywords.push(term)
        entry.weight += weight
        pairData.set(key, entry)
      }
    }
  }

  let kept = pairData
  if (sparsify !== undefined && sparsify.topK > 0) {
    // Mutual top-K: per endpoint, rank incident pairs by descending weight
    // (deterministic key order breaks ties) and keep only pairs that both
    // endpoints selected.
    const votes = new Map<string, number>()
    const incident = new Map<string, { key: string; weight: number }[]>()
    for (const [key, { weight }] of pairData) {
      const [a, b] = key.split('\x00') as [string, string]
      incident.get(a)?.push({ key, weight }) ?? incident.set(a, [{ key, weight }])
      incident.get(b)?.push({ key, weight }) ?? incident.set(b, [{ key, weight }])
    }
    for (const pairs of incident.values()) {
      pairs.sort((x, y) => y.weight - x.weight || codeUnitCompare(x.key, y.key))
      for (const { key } of pairs.slice(0, sparsify.topK)) {
        votes.set(key, (votes.get(key) ?? 0) + 1)
      }
    }
    kept = new Map()
    for (const [key, value] of pairData) {
      if ((votes.get(key) ?? 0) === 2) kept.set(key, value)
    }
  }

  const edges: GraphEdge[] = []
  for (const [key, { keywords, weight }] of kept) {
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

type LoadedNotes = Awaited<ReturnType<typeof loadVaultNotes>>

function snapshotHash(loaded: LoadedNotes, resolved: ResolvedConfig): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify([resolved.extensions, resolved.excludeDirs, resolved.indexHiddenDirs]))
  for (const note of [...loaded.parsed].sort((a, b) => codeUnitCompare(a.id, b.id))) {
    hash.update(JSON.stringify([note.id, note.text]))
  }
  return hash.digest('hex')
}

async function loadStableNotes(
  root: string, resolved: ResolvedConfig, onSkip: (path: string, error: unknown) => void,
): Promise<{ loaded: LoadedNotes; snapshotId: string; verify: () => Promise<{ scanStable: boolean; skippedEntries: number }> }> {
  const skipped = new Set<string>()
  const trackSkip = (path: string, error: unknown): void => {
    skipped.add(path)
    onSkip(path, error)
  }
  const loaded = await loadVaultNotes(root, resolved, trackSkip)
  const snapshotId = snapshotHash(loaded, resolved)
  return {
    loaded, snapshotId,
    verify: async () => {
      const confirmation = await loadVaultNotes(root, resolved, trackSkip)
      return { scanStable: snapshotId === snapshotHash(confirmation, resolved), skippedEntries: skipped.size }
    },
  }
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
function compareEdges(a: GraphEdge, b: GraphEdge): number {
  const linkFirst = (a.type === 'keyword' ? 1 : 0) - (b.type === 'keyword' ? 1 : 0)
  if (linkFirst !== 0) return linkFirst
  const weightOrder = (b.weight ?? 0) - (a.weight ?? 0)
  if (weightOrder !== 0) return weightOrder
  return codeUnitCompare(a.from, b.from) || codeUnitCompare(a.to, b.to)
}

function capEdges(edges: GraphEdge[], maxEdges: number): { edges: GraphEdge[]; truncated: boolean } {
  if (edges.length <= maxEdges) return { edges, truncated: false }
  return { edges: [...edges].sort(compareEdges).slice(0, maxEdges), truncated: true }
}

function graphResult(
  nodes: GraphNode[], edges: GraphEdge[], nodesTotal: number,
  maxNodes: number, maxEdges: number, excludedDirs: string[], depth?: number,
): MemoryGraph {
  const budgeted = capEdges(edges, maxEdges)
  return {
    nodes, edges: budgeted.edges,
    truncated: nodes.length < nodesTotal, edgesTruncated: budgeted.truncated,
    nodesTotal, nodesReturned: nodes.length,
    edgesTotal: edges.length, edgesReturned: budgeted.edges.length,
    edgesDropped: edges.length - budgeted.edges.length,
    effectiveMaxNodes: maxNodes, effectiveMaxEdges: maxEdges, excludedDirs,
    ...(depth === undefined ? {} : { depth }),
  }
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
  maxNodes: number,
  maxEdges: number,
  onSkip?: (path: string, error: unknown) => void,
  loaded?: LoadedNotes,
  maxKeywordPairs?: number,
): Promise<MemoryGraph> {
  const { parsed, linkResolver } = loaded ?? await loadVaultNotes(root, resolved, onSkip)

  const capped = [...parsed].sort((a, b) => codeUnitCompare(a.id, b.id)).slice(0, maxNodes)
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
  const sparsify: KeywordSparsify = { maxDocFraction: resolved.keywordMaxDocFraction, topK: resolved.keywordEdgeTopK }
  edges.push(...buildKeywordEdges(noteTerms, maxKeywordPairs, sparsify))

  // Safety: every edge endpoint must be in the returned node set.
  const safeEdges = edges.filter(e => idSet.has(e.from) && idSet.has(e.to))
  return graphResult(nodes, safeEdges, parsed.length, maxNodes, maxEdges, resolved.excludeDirs)
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
  maxNodes: number,
  maxEdges: number,
  onSkip?: (path: string, error: unknown) => void,
  loaded?: LoadedNotes,
  maxKeywordPairs?: number,
): Promise<MemoryGraph> {
  const { parsed, parsedById, linkResolver, skipped } = loaded ?? await loadVaultNotes(root, resolved, onSkip)
  const startPath = await containedPathReal(root, startId)
  const startNoteId = vaultRelativeId(root, startPath)
  // A missing path, a directory, or a file outside the configured extensions
  // resolves fine but has no indexed note; seeding the BFS with it would crash
  // on the first `parsedById.get(id)!` lookup.
  if (!parsedById.has(startNoteId)) {
    const excluded = startNoteId.split('/').some(segment => resolved.excludeDirs.includes(segment))
    const supported = resolved.extensions.some(ext => startNoteId.endsWith(ext.startsWith('.') ? ext : `.${ext}`))
    if (excluded && supported && await stat(startPath).then(info => info.isFile(), () => false)) {
      throw new Error(`tool-memory-graph: note excluded by excludeDirs: ${startNoteId}`)
    }
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
  const sparsify: KeywordSparsify = { maxDocFraction: resolved.keywordMaxDocFraction, topK: resolved.keywordEdgeTopK }
  const keywordEdges = buildKeywordEdges(noteTerms, maxKeywordPairs, sparsify)
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

  const ids = [...visited.keys()]
    .sort((a, b) => (visited.get(a) ?? 0) - (visited.get(b) ?? 0) || codeUnitCompare(a, b))
    .slice(0, maxNodes)
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

  return graphResult(nodes, edges, visited.size, maxNodes, maxEdges, resolved.excludeDirs, depth)
}

async function auditGraph(root: string, resolved: ResolvedConfig, onSkip: (path: string, error: unknown) => void) {
  const { loaded, snapshotId, verify } = await loadStableNotes(root, resolved, onSkip)
  const ids = new Set(loaded.parsed.map(note => note.id))
  const isExcluded = (id: string): boolean => id.split('/').some(segment => resolved.excludeDirs.includes(segment))
  const isArchived = (id: string): boolean => id.startsWith('archive/')
  let checkedLinks = 0
  let linkErrors = 0
  let excludedEdgeEndpoints = 0
  let archiveEdgeEndpoints = 0
  for (const note of loaded.parsed) {
    for (const link of extractLinks(note.text)) {
      checkedLinks++
      let targetPath
      try {
        targetPath = await resolveLinkTarget(root, resolved.extensions, link, loaded.linkResolver)
      } catch (error) {
        linkErrors++
        onSkip(note.path, error)
        continue
      }
      if (targetPath === undefined) continue
      const targetId = vaultRelativeId(root, targetPath)
      if (!ids.has(targetId)) continue
      if (isExcluded(note.id) || isExcluded(targetId)) excludedEdgeEndpoints++
      if (isArchived(note.id) || isArchived(targetId)) archiveEdgeEndpoints++
    }
  }
  const excludedNodesInIndex = loaded.parsed.filter(note => isExcluded(note.id)).length
  const archiveNodesInIndex = loaded.parsed.filter(note => isArchived(note.id)).length
  if (excludedNodesInIndex > 0 || archiveNodesInIndex > 0) {
    const noteTerms = new Map(loaded.parsed.map(note => [note.id, note.terms]))
    for (const edge of buildKeywordEdges(noteTerms)) {
      if (isExcluded(edge.from) || isExcluded(edge.to)) excludedEdgeEndpoints++
      if (isArchived(edge.from) || isArchived(edge.to)) archiveEdgeEndpoints++
    }
  }
  const { scanStable, skippedEntries } = await verify()
  const skipped = skippedEntries + linkErrors
  const complete = scanStable && skipped === 0
  return {
    indexedNodes: loaded.parsed.length, checkedLinks, excludedDirsApplied: resolved.excludeDirs,
    excludedNodesInIndex,
    excludedEdgeEndpoints, archiveNodesInIndex, archiveEdgeEndpoints,
    skippedEntries: skipped, scanStable, complete,
    archiveExcluded: complete && resolved.excludeDirs.includes('archive') && archiveNodesInIndex === 0 && archiveEdgeEndpoints === 0,
    snapshotId,
  }
}

interface GraphCursor {
  v: number
  kind: 'nodes' | 'edges'
  id: string | null
  depth: number | null
  offset: number
  snapshotId: string
}

function parseCursor(cursor: string): GraphCursor {
  const invalid = (): never => { throw new Error('tool-memory-graph: invalid graph cursor') }
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid()
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    invalid()
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const parsed = value as Partial<GraphCursor>
  if (parsed.v !== 1 || !['nodes', 'edges'].includes(parsed.kind ?? '')
    || (parsed.id !== null && typeof parsed.id !== 'string')
    || (parsed.depth !== null && !Number.isSafeInteger(parsed.depth))
    || !Number.isSafeInteger(parsed.offset) || (parsed.offset ?? -1) < 0
    || typeof parsed.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.snapshotId)) invalid()
  return parsed as GraphCursor
}

async function pageGraph(
  root: string, resolved: ResolvedConfig,
  kind: 'nodes' | 'edges', id: string | undefined, depth: number,
  pageSize: number, cursor: string | undefined,
  onSkip: (path: string, error: unknown) => void,
) {
  const parsedCursor = cursor === undefined ? undefined : parseCursor(cursor)
  const scopeId = id ?? null
  const scopeDepth = id === undefined ? null : depth
  if (parsedCursor !== undefined && (parsedCursor.kind !== kind || parsedCursor.id !== scopeId || parsedCursor.depth !== scopeDepth)) {
    throw new Error('tool-memory-graph: invalid graph cursor for this query')
  }
  const { loaded, snapshotId, verify } = await loadStableNotes(root, resolved, onSkip)
  if (loaded.parsed.length > resolved.pageScanNodesLimit) {
    throw new Error(`tool-memory-graph: graph page scan exceeds pageScanNodesLimit (${resolved.pageScanNodesLimit})`)
  }
  const maxPairs = Math.floor(resolved.pageScanEdgesLimit / 2)
  const graph = id === undefined
    ? await buildGraph(root, resolved, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, onSkip, loaded, maxPairs)
    : await buildSubgraph(root, resolved, id, depth, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, onSkip, loaded, maxPairs)
  if (graph.edgesTotal > resolved.pageScanEdgesLimit) {
    throw new Error(`tool-memory-graph: graph page scan exceeds pageScanEdgesLimit (${resolved.pageScanEdgesLimit})`)
  }
  const nodes = graph.nodes
  const edges = [...graph.edges].sort(compareEdges)
  const hash = createHash('sha256').update(snapshotId).update(JSON.stringify([scopeId, scopeDepth]))
  for (const node of nodes) hash.update(JSON.stringify(node))
  for (const edge of edges) hash.update(JSON.stringify(edge))
  const graphSnapshot = hash.digest('hex')
  const { scanStable, skippedEntries } = await verify()
  if (!scanStable || skippedEntries > 0) throw new Error('tool-memory-graph: graph snapshot unavailable; vault changed or contains unreadable entries')
  if (parsedCursor !== undefined && parsedCursor.snapshotId !== graphSnapshot) {
    throw new Error('tool-memory-graph: stale graph snapshot; restart pagination')
  }
  const all = kind === 'nodes' ? nodes : edges
  const offset = parsedCursor?.offset ?? 0
  if (offset > all.length || (offset === all.length && all.length > 0)) {
    throw new Error('tool-memory-graph: invalid graph cursor offset')
  }
  const appliedSize = Math.min(pageSize, resolved.pageSizeLimit)
  const items = all.slice(offset, offset + appliedSize)
  const nextOffset = offset + items.length
  const nextCursor = nextOffset < all.length
    ? Buffer.from(JSON.stringify({ v: 1, kind, id: scopeId, depth: scopeDepth, offset: nextOffset, snapshotId: graphSnapshot } satisfies GraphCursor)).toString('base64url')
    : null
  return {
    kind, nodes: kind === 'nodes' ? items : [], edges: kind === 'edges' ? items : [],
    total: all.length, offset, pageSize: appliedSize, nextCursor, snapshotId: graphSnapshot,
    excludedDirs: resolved.excludeDirs,
  }
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
  assertPositiveInteger('maxNodesLimit', resolved.maxNodesLimit)
  assertPositiveInteger('maxEdges', resolved.maxEdges)
  assertPositiveInteger('maxEdgesLimit', resolved.maxEdgesLimit)
  assertPositiveInteger('pageSizeLimit', resolved.pageSizeLimit)
  assertPositiveInteger('pageScanNodesLimit', resolved.pageScanNodesLimit)
  assertPositiveInteger('pageScanEdgesLimit', resolved.pageScanEdgesLimit)
  assertExtensions(resolved.extensions)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_graph',
    description: 'Return the link and keyword graph of the wiki vault. Explicit `[[link]]` edges have from/to (no type); keyword edges have type `keyword`, keywords and weight. Optional id/depth selects a subgraph. Per-call maxNodes/maxEdges are clamped to configured maxNodesLimit/maxEdgesLimit and reported as effectiveMaxNodes/effectiveMaxEdges. Returns nodesTotal/nodesReturned and edgesTotal/edgesReturned/edgesDropped; edgesTotal counts edges between returned nodes before the edge cap, not edges lost to a node cap. truncated/edgesTruncated retain their meanings. excludedDirs reports directory names omitted before link resolution; an existing excluded center fails with a distinct error. Only when both truncation flags are false is the returned graph exhaustive.',
    parameters: {
      id: {
        type: 'string',
        description: 'Optional vault-relative note id to center the subgraph on (e.g. "concepts/RAG.md").',
      },
      depth: {
        type: 'integer',
        description: 'Maximum link or keyword hops from the center note; defaults to the configured maxDepth and is capped at the configured maxDepthLimit.',
      },
      maxNodes: {
        type: 'integer',
        description: 'Optional node result cap, clamped to configured maxNodesLimit; the applied cap is returned as effectiveMaxNodes.',
      },
      maxEdges: {
        type: 'integer',
        description: 'Optional edge result cap, clamped to configured maxEdgesLimit; the applied cap is returned as effectiveMaxEdges.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = resolveMemoryVaultRoot(resolved.vaultRoot, exec)
      const requestedDepth = args.depth ?? resolved.maxDepth
      const requestedNodes = args.maxNodes ?? resolved.maxNodes
      const requestedEdges = args.maxEdges ?? resolved.maxEdges
      assertPositiveInteger('depth', requestedDepth)
      assertPositiveInteger('maxNodes', requestedNodes)
      assertPositiveInteger('maxEdges', requestedEdges)
      const depth = Math.min(requestedDepth, resolved.maxDepthLimit)
      const maxNodes = Math.min(requestedNodes, resolved.maxNodesLimit)
      const maxEdges = Math.min(requestedEdges, resolved.maxEdgesLimit)
      const onSkip = skipLogger(ctx, vaultRoot)
      const graph = args.id === undefined
        ? await buildGraph(vaultRoot, resolved, maxNodes, maxEdges, onSkip)
        : await buildSubgraph(vaultRoot, resolved, args.id, depth, maxNodes, maxEdges, onSkip)
      return graph as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_graph_audit',
    description: 'Read-only vault-wide graph isolation audit without returning graph edges. Reports indexedNodes, checkedLinks, excludedDirsApplied, excludedNodesInIndex, excludedEdgeEndpoints, archiveNodesInIndex, archiveEdgeEndpoints, skippedEntries, scanStable, complete, archiveExcluded and snapshotId. complete is false if files were skipped or two scans differed; archiveExcluded is true only when complete and archive/ was actually excluded from the index and edge endpoints.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const root = resolveMemoryVaultRoot(resolved.vaultRoot, exec)
      return await auditGraph(root, resolved, skipLogger(ctx, root)) as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_graph_page',
    description: 'Read-only, content-snapshot-validated paging of graph nodes or edges. Choose kind nodes or edges; optional id/depth selects a subgraph, pageSize defaults to 100 and is clamped to pageSizeLimit. Pass nextCursor with the same query and kind for the next page. A changed vault yields stale graph snapshot instead of silently skipping or duplicating results. Returns { kind, nodes, edges, total, offset, pageSize, nextCursor, snapshotId, excludedDirs }. Each page rescans the vault and rebuilds the graph; very large scans are refused by pageScanNodesLimit/pageScanEdgesLimit.',
    parameters: {
      kind: { type: 'string', enum: ['nodes', 'edges'], required: true, description: 'Page graph nodes or edges.' },
      id: { type: 'string', description: 'Optional vault-relative center id; must match on every cursor request.' },
      depth: { type: 'integer', description: 'Optional subgraph depth; must match on every cursor request.' },
      pageSize: { type: 'integer', description: 'Optional page size (default 100), clamped to pageSizeLimit.' },
      cursor: { type: 'string', description: 'Opaque nextCursor returned by the preceding page.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const root = resolveMemoryVaultRoot(resolved.vaultRoot, exec)
      const requestedDepth = args.depth ?? resolved.maxDepth
      const requestedSize = args.pageSize ?? 100
      assertPositiveInteger('depth', requestedDepth)
      assertPositiveInteger('pageSize', requestedSize)
      return await pageGraph(
        root, resolved, args.kind, args.id, Math.min(requestedDepth, resolved.maxDepthLimit),
        requestedSize, args.cursor, skipLogger(ctx, root),
      ) as unknown as JsonValue
    },
  })))
}
