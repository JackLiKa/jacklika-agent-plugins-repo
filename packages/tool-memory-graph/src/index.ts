/**
 * Model-facing link-graph tool over a Markdown memory vault. The package
 * registers `wiki_graph`, which returns the vault's note/link graph or the
 * subgraph reachable from one note, so an agent can reason about how memory
 * notes connect before reading them.
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
  /** Maximum nodes returned in one graph. */
  maxNodes?: number
  /** Descend into dot-directories besides the fixed exclusions while indexing. */
  indexHiddenDirs?: boolean
}

/** Schemastery configuration for the memory graph tool consumer. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().default(''),
  extensions: z.array(z.string()).default(['.md']),
  maxDepth: z.number().default(1),
  maxNodes: z.number().default(200),
  indexHiddenDirs: z.boolean().default(false),
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

/** One directed `[[link]]` edge between notes. */
interface GraphEdge {
  /** Source note id containing the link. */
  from: string
  /** Target note id the link resolves to. */
  to: string
}

/** The complete or partial link graph returned by `wiki_graph`. */
interface MemoryGraph {
  /** Notes in the returned graph, capped at `maxNodes`. */
  nodes: GraphNode[]
  /** Resolved links between returned nodes. */
  edges: GraphEdge[]
  /** Whether `maxNodes` truncated the node set. */
  truncated: boolean
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-memory-graph: ${name} must be a positive integer`)
  }
}

async function noteTitle(absolutePath: string, id: string): Promise<string> {
  const text = await readFile(absolutePath, 'utf8')
  const { body } = splitFrontmatter(text)
  const heading = /^#\s+(.+)$/m.exec(body)
  return heading?.[1]?.trim() ?? id.replace(/\.[^.]+$/, '')
}

/**
 * Build the vault-wide link graph: every note is a node; every `[[link]]`
 * that resolves to an existing note is an edge.
 * @param root - vault root.
 * @param resolved - applied plugin configuration.
 * @returns the full graph, node-capped.
 */
async function buildGraph(root: string, resolved: ResolvedConfig): Promise<MemoryGraph> {
  const paths = await listNotePaths(root, resolved.extensions, resolved.indexHiddenDirs)
  const entries = paths.map(path => [vaultRelativeId(root, path), path] as const)
  const linkResolver = createLinkResolver(entries.map(([id]) => id))

  const truncated = entries.length > resolved.maxNodes
  // `listNotePaths` follows readdir order, so the node cap would otherwise keep
  // a filesystem-dependent subset of the vault.
  const capped = [...entries].sort((a, b) => codeUnitCompare(a[0], b[0])).slice(0, resolved.maxNodes)
  const nodes: GraphNode[] = []
  for (const [id, path] of capped) nodes.push({ id, title: await noteTitle(path, id) })

  const idSet = new Set(capped.map(([id]) => id))
  const edges: GraphEdge[] = []
  for (const [id, path] of capped) {
    const text = await readFile(path, 'utf8')
    for (const link of extractLinks(text)) {
      const targetPath = await resolveLinkTarget(root, resolved.extensions, link, linkResolver)
      if (targetPath === undefined) continue
      const targetId = vaultRelativeId(root, targetPath)
      if (idSet.has(targetId)) edges.push({ from: id, to: targetId })
    }
  }
  return { nodes, edges, truncated }
}

/**
 * Collect the subgraph reachable from one note by following `[[link]]`
 * references breadth-first up to `depth`.
 * @param root - vault root.
 * @param resolved - applied plugin configuration.
 * @param startId - vault-relative id of the center note.
 * @param depth - maximum link hops from the center.
 * @returns the neighborhood graph, node-capped.
 */
async function buildSubgraph(
  root: string,
  resolved: ResolvedConfig,
  startId: string,
  depth: number,
): Promise<MemoryGraph> {
  const startPath = await containedPathReal(root, startId)
  const linkResolver = createLinkResolver(
    (await listNotePaths(root, resolved.extensions, resolved.indexHiddenDirs))
      .map(path => vaultRelativeId(root, path)),
  )
  const visited = new Map<string, string>([[vaultRelativeId(root, startPath), startPath]])
  const levels = new Map<string, number>([[vaultRelativeId(root, startPath), 0]])
  let frontier = [startPath]

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = []
    for (const path of frontier) {
      const text = await readFile(path, 'utf8')
      for (const link of extractLinks(text)) {
        const targetPath = await resolveLinkTarget(root, resolved.extensions, link, linkResolver)
        if (targetPath === undefined) continue
        const toId = vaultRelativeId(root, targetPath)
        if (!visited.has(toId)) {
          visited.set(toId, targetPath)
          levels.set(toId, level + 1)
          next.push(targetPath)
        }
      }
    }
    frontier = next
  }

  const truncated = visited.size > resolved.maxNodes
  // Truncate by distance from the center, then by id: the neighborhood closest
  // to the requested note survives the cap, and which notes those are does not
  // depend on readdir or link order.
  const ids = [...visited.keys()]
    .sort((a, b) => (levels.get(a) ?? 0) - (levels.get(b) ?? 0) || codeUnitCompare(a, b))
    .slice(0, resolved.maxNodes)
  const idSet = new Set(ids)
  const edges: GraphEdge[] = []
  const nodes: GraphNode[] = []
  for (const id of ids) {
    const path = await containedPathReal(root, id)
    nodes.push({ id, title: await noteTitle(path, id) })
    const text = await readFile(path, 'utf8')
    for (const link of extractLinks(text)) {
      const targetPath = await resolveLinkTarget(root, resolved.extensions, link, linkResolver)
      if (targetPath === undefined) continue
      const toId = vaultRelativeId(root, targetPath)
      if (idSet.has(toId)) edges.push({ from: id, to: toId })
    }
  }
  return { nodes, edges, truncated }
}

/**
 * Register the `wiki_graph` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit vault configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.get('tools') as { register?: unknown } | undefined
  if (typeof tools?.register !== 'function') {
    ctx.logger?.warn('tool-memory-graph: ctx.tools.register unavailable; wiki_graph tool will not register.')
    return
  }

  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxDepth', resolved.maxDepth)
  assertPositiveInteger('maxNodes', resolved.maxNodes)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_graph',
    description: 'Return the Obsidian-style [[link]] graph of the wiki vault: note ids, titles, and directed edges. Without an id it returns the whole vault graph (node-capped); with an id it returns the subgraph reachable from that note within the given depth.',
    parameters: {
      id: {
        type: 'string',
        description: 'Optional vault-relative note id to center the subgraph on (e.g. "concepts/RAG.md").',
      },
      depth: {
        type: 'integer',
        description: 'Maximum [[link]] hops from the center note; defaults to the configured maxDepth.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = resolveMemoryVaultRoot(resolved.vaultRoot, exec)
      const depth = args.depth ?? resolved.maxDepth
      assertPositiveInteger('depth', depth)
      const graph = args.id === undefined
        ? await buildGraph(vaultRoot, resolved)
        : await buildSubgraph(vaultRoot, resolved, args.id, depth)
      return graph as unknown as JsonValue
    },
  })))
}
