/**
 * Model-facing wiki/memory tools over a local Markdown vault. The package
 * provides `wiki_read`, `wiki_search`, and `wiki_write` so an agent can treat a
 * directory of Markdown notes as long-term memory. Notes are plain files with
 * YAML frontmatter and Obsidian-style `[[link]]` references; the agent reads,
 * searches, and appends notes through the tool registry without touching core
 * packages.
 * @module @jacklika/dsh-tool-memory-filesystem
 */

import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { formatBeijingTime } from '@jacklika/dsh-memory-time'
import yaml from 'js-yaml'
import { codeUnitCompare, fuseRankings, rankNotes } from './search.ts'
import type { IndexedNote, Note } from './types.ts'

export type * from './types.ts'

/**
 * Locale-independent note-id ordering, re-exported so sibling packages that
 * truncate or tie-break id lists sort by the same rule instead of a copy that
 * can drift.
 */
export { codeUnitCompare }

/**
 * Compute a vault-relative note id from an absolute path. The result always
 * uses POSIX separators so note ids are stable across Windows, macOS, and Linux.
 */
export function vaultRelativeId(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replace(/\\/g, '/')
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory-filesystem'

/** Services required by the wiki/memory tool suite. */
export const inject = ['tools']

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
  /** Maximum depth to follow `[[link]]` references when reading a note. */
  maxLinkDepth?: number
  /** Maximum number of search hits to return. */
  maxSearchResults?: number
  /**
   * Descend into dot-directories while indexing. `.git`, `.obsidian`, and
   * `node_modules` are always excluded. Enable this when `vaultRoot` points at
   * a directory whose notes live under a hidden path such as `.dsh/memory/`.
   */
  indexHiddenDirs?: boolean
}

/** Schemastery configuration for the filesystem memory tool consumer. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().default(''),
  extensions: z.array(z.string()).default(['.md']),
  maxLinkDepth: z.number().default(1),
  maxSearchResults: z.number().default(20),
  indexHiddenDirs: z.boolean().default(false),
})

/** The shape after schemastery applied the defaults; `vaultRoot` is `''` when unset. */
type ResolvedConfig = Required<Config>

/**
 * Compute the vault root for one tool call: an explicit `vaultRoot` wins,
 * resolved relative to the session workspace; otherwise the call gets
 * `<session cwd>/.dsh/memory/` so each workspace owns its notes.
 * @param vaultRoot - the configured root (`''` selects the per-workspace default).
 * @param exec - the current tool execution carrying the agent session.
 * @returns absolute vault root for this call.
 */
export function resolveMemoryVaultRoot(
  vaultRoot: string | undefined,
  exec: Pick<ToolRunContext, 'agent'>,
): string {
  const sessionCwd = exec.agent?.session.header.cwd ?? process.cwd()
  if (vaultRoot === undefined || vaultRoot === '') {
    return join(sessionCwd, '.dsh', 'memory')
  }
  return isAbsolute(vaultRoot) ? vaultRoot : resolve(sessionCwd, vaultRoot)
}

/**
 * Reject paths that escape the vault root. The check resolves the candidate,
 * normalizes `..`, and requires the result to start with the root path followed
 * by a path separator (or equal the root itself).
 * @param root - absolute vault root.
 * @param candidate - a relative or absolute path.
 * @returns the absolute, contained path.
 */
export function containedPath(root: string, candidate: string): string {
  const absoluteRoot = resolve(root)
  const absolute = resolve(absoluteRoot, candidate)
  const remainder = relative(absoluteRoot, absolute)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`tool-memory-filesystem: path ${candidate} is outside vault root ${root}`)
  }
  return absolute
}

/**
 * Resolve a vault path and reject an existing symlink or junction component
 * whose real target leaves the vault. The nearest existing ancestor protects
 * paths whose final file or directories do not exist yet.
 * @param root - vault root; it must exist.
 * @param candidate - vault-relative path.
 * @returns the absolute lexical path after realpath containment succeeds.
 */
export async function containedPathReal(root: string, candidate: string): Promise<string> {
  const absolute = containedPath(root, candidate)
  const canonicalRoot = await realpath(resolve(root))
  let ancestor = absolute
  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor)
      const remainder = relative(canonicalRoot, canonicalAncestor)
      if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
        throw new Error(`tool-memory-filesystem: path ${candidate} resolves outside vault root ${root}`)
      }
      return absolute
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
}

/**
 * Extract YAML frontmatter and body from Markdown text. Only the leading
 * `---\n...\n---\n` form is recognized.
 * @param text - raw file contents.
 * @returns frontmatter map and body.
 */
export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (match === null) {
    return { frontmatter: {}, body: text }
  }
  const frontmatterText = match[1] ?? ''
  const bodyText = match[2] ?? ''
  try {
    const parsed = yaml.load(frontmatterText)
    const frontmatter: Record<string, unknown> = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
    // js-yaml coerces unquoted timestamps to Date; vault convention stores them
    // as Asia/Shanghai +08:00 strings, so convert back before they reach callers.
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value instanceof Date) frontmatter[key] = formatBeijingTime(value)
    }
    return { frontmatter, body: bodyText }
  } catch {
    return { frontmatter: {}, body: text }
  }
}

/**
 * Fingerprint one note's raw file contents. The value lets `wiki_write`
 * detect that another writer changed the note since it was read.
 * @param text - raw file contents.
 * @returns content hash stable across processes.
 */
export function noteVersion(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * Last `mtimeMs` observed per note path, keyed by absolute path so identical
 * note ids in different vaults never collide. Bounded at 256 entries with
 * LRU eviction: an unbounded map would grow with every note ever read in a
 * long-running process, while a fixed cap keeps the newest observations —
 * the only ones a `modifiedExternally` comparison can still act on.
 */
const observedMtimes = new Map<string, number>()
const OBSERVED_MTIME_LIMIT = 256

/**
 * Record the freshest observed `mtimeMs` for a path, evicting the oldest
 * entry when the cap is reached.
 */
function recordMtime(path: string, mtimeMs: number): void {
  observedMtimes.delete(path)
  observedMtimes.set(path, mtimeMs)
  if (observedMtimes.size > OBSERVED_MTIME_LIMIT) {
    const oldest = observedMtimes.keys().next().value
    if (oldest !== undefined) observedMtimes.delete(oldest)
  }
}

/**
 * Whether the note changed on disk since this plugin last observed it.
 * The first observation records and reports `false`; a successful
 * `wiki_write` re-records so the plugin's own writes never flag.
 */
function detectExternalChange(path: string, mtimeMs: number): boolean {
  const seen = observedMtimes.get(path)
  recordMtime(path, mtimeMs)
  return seen !== undefined && seen !== mtimeMs
}

/**
 * Normalize `created`/`updated` frontmatter timestamps to the vault's
 * `+08:00` second-precision convention. Parseable values in any other form
 * (`Z`, `+00:00`, millisecond precision) are rewritten; unparseable values
 * pass through untouched so a non-date string is never corrupted.
 */
export function normalizeNoteTimestamps(frontmatter: Record<string, unknown>): void {
  for (const key of ['created', 'updated']) {
    const value = frontmatter[key]
    if (typeof value !== 'string') continue
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) continue
    const normalized = formatBeijingTime(parsed)
    if (normalized !== value) frontmatter[key] = normalized
  }
}

/**
 * Normalize timestamps inside a complete note text. Returns the text
 * unchanged when there is no frontmatter to rewrite.
 */
function normalizeTextTimestamps(text: string): string {
  const { frontmatter, body } = splitFrontmatter(text)
  if (Object.keys(frontmatter).length === 0) return text
  normalizeNoteTimestamps(frontmatter)
  return `---\n${yaml.dump(frontmatter).trim()}\n---\n${body}`
}

/**
 * Find all Obsidian-style `[[link]]` references in note text. Aliases of the
 * form `[[link|alias]]` return the link target only.
 * @param text - note body.
 * @returns array of link targets.
 */
export function extractLinks(text: string): string[] {
  const links: string[] = []
  const pattern = /\[\[([^|\]\r\n]+)(?:\|[^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stripCode(text))) !== null) {
    if (match[1] !== undefined) links.push(match[1].trim())
  }
  return [...new Set(links)]
}

/**
 * Remove fenced code blocks and inline code spans so literal `[[...]]` inside
 * them is not treated as a link. Fences follow CommonMark: a closing fence
 * must use the same marker character and be at least as long as the opener —
 * a rule a regex backreference cannot express, so fences are scanned line by
 * line. Inline spans treat backtick runs as maximal units: a run closes only
 * at a later run of exactly equal length; an unmatched run is literal text.
 * @param text - note body.
 * @returns the text with all code sections dropped.
 */
function stripCode(text: string): string {
  const kept: string[] = []
  let fenceChar = ''
  let fenceLen = 0
  for (const line of text.split('\n')) {
    if (fenceChar === '') {
      const open = /^( {0,3})(`{3,}|~{3,})/.exec(line)
      if (open?.[2] !== undefined) {
        fenceChar = open[2][0] ?? ''
        fenceLen = open[2].length
        continue
      }
      kept.push(line)
    } else if (new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLen},}[ \t]*$`).test(line)) {
      fenceChar = ''
    }
  }
  const body = kept.join('\n')
  let out = ''
  let i = 0
  while (i < body.length) {
    if (body[i] !== '`') {
      out += body[i]
      i++
      continue
    }
    let j = i
    while (body[j] === '`') j++
    const run = body.slice(i, j)
    let close = body.indexOf(run, j)
    while (close !== -1 && (body[close - 1] === '`' || body[close + run.length] === '`')) {
      close = body.indexOf(run, close + 1)
    }
    if (close === -1) {
      out += run
      i = j
      continue
    }
    i = close + run.length
  }
  return out
}

/**
 * Normalize a configured file extension to a dot-prefixed form.
 * @param ext - extension string.
 * @returns `.md` form.
 */
export function dottedExtension(ext: string): string {
  return ext.startsWith('.') ? ext : `.${ext}`
}

/**
 * A link resolver maps an Obsidian `[[target]]` to a vault-relative note id,
 * or `undefined` when nothing matches.
 */
export type LinkResolver = (target: string) => string | undefined

/**
 * Build a resolver over the known note ids, matching Obsidian semantics: an
 * exact vault-relative path first, then a path-suffix match, then a bare
 * basename match — each tier tolerates the target carrying or omitting the
 * extension. Ambiguity within a tier resolves to the id with the fewest path
 * segments, ties by code-unit order, so results are identical across hosts.
 * @param ids - vault-relative note ids (e.g. `shared/notes/foo.md`).
 * @returns resolver function for `[[...]]` targets.
 */
export function createLinkResolver(ids: string[]): LinkResolver {
  interface Entry {
    id: string
    stem: string
    basenameId: string
    basenameStem: string
    segments: number
  }
  const entries: Entry[] = ids.map(id => {
    const stem = id.replace(/\.[^./]+$/, '')
    return {
      id,
      stem,
      basenameId: id.slice(id.lastIndexOf('/') + 1),
      basenameStem: stem.slice(stem.lastIndexOf('/') + 1),
      segments: id.split('/').length,
    }
  })
  // O(1) lookup tables keyed by every segment-boundary suffix of each id and
  // stem: an exact hit is the full-string key, a path-suffix hit is a proper
  // suffix, and a basename hit is the last segment.
  const exact = new Map<string, Entry[]>()
  const suffix = new Map<string, Entry[]>()
  const basename = new Map<string, Entry[]>()
  const add = (table: Map<string, Entry[]>, key: string, entry: Entry): void => {
    const list = table.get(key)
    if (list === undefined) table.set(key, [entry])
    else list.push(entry)
  }
  for (const entry of entries) {
    add(basename, entry.basenameId, entry)
    add(basename, entry.basenameStem, entry)
    for (const s of [entry.id, entry.stem]) {
      let boundary = -1
      while ((boundary = s.indexOf('/', boundary + 1)) !== -1) {
        add(suffix, s.slice(boundary + 1), entry)
      }
      add(exact, s, entry)
    }
  }
  const pick = (matches: Entry[] | undefined): string | undefined => {
    if (matches === undefined || matches.length === 0) return undefined
    matches.sort((a, b) => a.segments - b.segments || codeUnitCompare(a.id, b.id))
    return matches[0]?.id
  }
  return (target: string) => {
    const t = target.replace(/\\/g, '/')
    const hit = pick(exact.get(t)) ?? pick(suffix.get(t)) ?? pick(basename.get(t))
    return hit
  }
}

/**
 * Resolve a link target to an existing note file inside the vault. When
 * `resolve` is provided the target is first looked up in the note-id set with
 * Obsidian semantics (exact path, then path suffix, then basename); otherwise
 * the target is probed as a vault-relative path and extensions are tried in
 * config order. Every result still passes the realpath containment check.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param target - link target from `[[...]]`.
 * @param resolve - optional resolver built by {@link createLinkResolver}.
 * @returns the resolved absolute path, or `undefined` if no file exists.
 */
export async function resolveLinkTarget(
  root: string,
  extensions: string[],
  target: string,
  resolve?: LinkResolver,
): Promise<string | undefined> {
  if (resolve !== undefined) {
    const id = resolve(target)
    if (id !== undefined) return containedPathReal(root, id)
  }
  const candidates = extensions.map(ext => `${target}${dottedExtension(ext)}`)
  candidates.push(target)
  for (const candidate of candidates) {
    try {
      const path = await containedPathReal(root, candidate)
      const info = await stat(path)
      if (info.isFile()) return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

/**
 * Recursively discover note files under the vault root. `.git`, `.obsidian`,
 * and `node_modules` are always excluded; other dot-directories are skipped
 * unless `indexHiddenDirs` is enabled.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param indexHiddenDirs - descend into remaining dot-directories.
 * @returns absolute paths of every note file.
 */
export async function listNotePaths(
  root: string,
  extensions: string[],
  indexHiddenDirs = false,
): Promise<string[]> {
  const results: string[] = []
  const exclude = new Set(['.git', 'node_modules', '.obsidian'])

  try {
    if (!(await stat(root)).isDirectory()) return results
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return results
    throw err
  }

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!indexHiddenDirs && entry.name.startsWith('.') && entry.name !== '.') continue
      if (exclude.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(dottedExtension(ext)))) {
        results.push(full)
      }
    }
  }

  await walk(root)
  return results
}

/** Wire view of one linked note, truncated to avoid deep recursion types. */
export interface LinkedNote {
  id: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
  links: string[]
  version: string
  linkedNotes: LinkedNote[]
}

/**
 * Read and parse one Markdown note, following configured link depth.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param maxLinkDepth - how many link hops to resolve.
 * @param absolutePath - absolute path of the note.
 * @param visited - set of already-visited absolute paths to prevent cycles.
 * @param linkResolver - resolver over the vault's note ids; built once per
 *   call tree so bare `[[filename]]` links resolve without rescanning.
 * @returns the parsed note with linked notes attached.
 */
export async function readNote(
  root: string,
  extensions: string[],
  maxLinkDepth: number,
  absolutePath: string,
  visited: ReadonlySet<string> = new Set(),
  linkResolver?: LinkResolver,
): Promise<Note & { linkedNotes: LinkedNote[] }> {
  if (visited.has(absolutePath)) {
    return {
      path: absolutePath,
      id: vaultRelativeId(root, absolutePath),
      frontmatter: {},
      body: '',
      links: [],
      version: '',
      linkedNotes: [],
    }
  }
  const nextVisited = new Set(visited)
  nextVisited.add(absolutePath)
  const text = await readFile(absolutePath, 'utf8')
  const { frontmatter, body } = splitFrontmatter(text)
  const links = extractLinks(text)
  const linkedNotes: LinkedNote[] = []
  if (maxLinkDepth > 0) {
    for (const link of links) {
      const target = await resolveLinkTarget(root, extensions, link, linkResolver)
      if (target !== undefined) {
        const child = await readNote(root, extensions, maxLinkDepth - 1, target, nextVisited, linkResolver)
        linkedNotes.push(child)
      }
    }
  }
  return {
    path: absolutePath,
    id: vaultRelativeId(root, absolutePath),
    frontmatter,
    body,
    links,
    version: noteVersion(text),
    linkedNotes,
  }
}

/**
 * Build a search index of note titles, bodies, and backlinks. The title is the
 * first Markdown `# heading` or the basename without extension; the body keeps
 * keyword search honest about the documented "titles and bodies" contract.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param indexHiddenDirs - descend into dot-directories besides the fixed exclusions.
 * @returns a map from note id to search result.
 */
export async function buildIndex(
  root: string,
  extensions: string[],
  indexHiddenDirs = false,
): Promise<Map<string, IndexedNote>> {
  const paths = await listNotePaths(root, extensions, indexHiddenDirs)
  const notes: Note[] = []
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    const { frontmatter, body } = splitFrontmatter(text)
    notes.push({
      path,
      id: vaultRelativeId(root, path),
      frontmatter,
      body,
      links: extractLinks(text),
      version: noteVersion(text),
    })
  }
  const index = new Map<string, IndexedNote>()
  for (const note of notes) {
    const headingMatch = /^#\s+(.+)$/m.exec(note.body)
    const title = headingMatch !== null && headingMatch[1] !== undefined
      ? headingMatch[1].trim()
      : note.id.replace(/\.[^.]+$/, '')
    index.set(note.id, { id: note.id, title, backlinks: [], body: note.body })
  }
  const linkResolver = createLinkResolver([...index.keys()])
  for (const note of notes) {
    for (const link of note.links) {
      const targetId = linkResolver(link)
      if (targetId !== undefined) {
        const entry = index.get(targetId)
        if (entry !== undefined && !entry.backlinks.includes(note.id)) {
          entry.backlinks.push(note.id)
        }
      }
    }
  }
  return index
}

/**
 * Write `contents` to `absolutePath` atomically: stage into a sibling temp
 * file, then `rename` over the target so concurrent readers never observe a
 * partially written note.
 * @param absolutePath - final note path inside the vault.
 * @param contents - complete file body to publish.
 */
async function writeAtomic(absolutePath: string, contents: string): Promise<void> {
  const tmpPath = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(tmpPath, contents, 'utf8')
    await rename(tmpPath, absolutePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Validate a positive-integer config bound. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-memory-filesystem: ${name} must be a positive integer`)
  }
}

/**
 * Register the `wiki_read`, `wiki_search`, and `wiki_write` tools on
 * `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit vault configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.get('tools') as { register?: unknown } | undefined
  if (typeof tools?.register !== 'function') {
    ctx.logger?.warn('tool-memory-filesystem: ctx.tools.register unavailable; wiki tools will not register.')
    return
  }

  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxLinkDepth', resolved.maxLinkDepth)
  assertPositiveInteger('maxSearchResults', resolved.maxSearchResults)

  const vaultRootFor = (exec: ToolRunContext): string => resolveMemoryVaultRoot(resolved.vaultRoot, exec)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_read',
    description: 'Read one Markdown note from the wiki vault, optionally following Obsidian-style [[link]] references up to the configured depth. Returns the note id, frontmatter, body, linked notes, mtime, and a modifiedExternally flag that is true when the file changed on disk since this tool last observed it.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Vault-relative path of the note to read (e.g. "concepts/RAG.md" or "daily/2026-09-23").',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const absolutePath = await containedPathReal(vaultRoot, args.id)
      const linkResolver = createLinkResolver(
        (await listNotePaths(vaultRoot, resolved.extensions, resolved.indexHiddenDirs))
          .map(path => vaultRelativeId(vaultRoot, path)),
      )
      const note = await readNote(vaultRoot, resolved.extensions, resolved.maxLinkDepth, absolutePath, new Set(), linkResolver)
      const info = await stat(absolutePath)
      return {
        ...note,
        mtime: formatBeijingTime(info.mtime),
        modifiedExternally: detectExternalChange(absolutePath, info.mtimeMs),
      } as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_search',
    description: 'Search the wiki vault by note title or body keyword. Terms are OR-matched; results are ranked by field-weighted relevance (title/id hits outrank body hits, rare terms weigh more, notes linked from strong hits get a boost, and results may be fused with semantic search when available). Returns matching note ids, titles, scores, and backlink counts. Use this before asking the user which note to read.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keyword or phrase to match against note titles and bodies.',
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
            title: { type: 'string' },
            score: { type: 'number' },
            backlinks: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const index = await buildIndex(vaultRoot, resolved.extensions, resolved.indexHiddenDirs)
      let hits = rankNotes(index, args.query)
      // Optional semantic layer: when `wiki_semantic_search` is mounted, fuse
      // both rankings via reciprocal rank fusion. Only the dispatch is
      // fail-soft — an unavailable or erroring semantic layer degrades to the
      // lexical ranking; parse/fusion errors propagate so real bugs surface
      // instead of silently weakening results.
      if (ctx.tools.get('wiki_semantic_search') !== undefined) {
        let semantic
        try {
          semantic = await ctx.tools.execute({
            callId: `${exec.callId}:wiki_semantic_search:${randomUUID()}` as typeof exec.callId,
            rootCallId: exec.rootCallId,
            name: 'wiki_semantic_search',
            arguments: { query: args.query },
            parent: exec.token,
            signal: exec.signal,
            ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
          })
        } catch (error) {
          ctx.logger?.warn('tool-memory-filesystem: semantic fusion skipped: ' + String(error))
        }
        if (semantic !== undefined && !semantic.isError) {
          const semanticHits = JSON.parse(
            semantic.content
              .map(block => {
                const maybe = block as { type?: unknown; text?: unknown }
                return maybe.type === 'text' && typeof maybe.text === 'string' ? maybe.text : ''
              })
              .join('') || '[]',
          ) as { id: string }[]
          hits = fuseRankings(hits, semanticHits.map(hit => hit.id), index)
        } else if (semantic !== undefined) {
          ctx.logger?.warn('tool-memory-filesystem: semantic fusion skipped: wiki_semantic_search returned an error')
        }
      }
      return hits.slice(0, resolved.maxSearchResults)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_write',
    description: 'Create a new note or append to an existing note in the wiki vault. The path is relative to the vault root. When appending, the new content is inserted at the end of the body after a timestamp header.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Vault-relative path of the note (e.g. "meetings/2026-09-23.md").',
      },
      content: {
        type: 'string',
        required: true,
        description: 'Markdown content to write or append.',
      },
      mode: {
        type: 'string',
        description: 'Either "append" (default) or "overwrite".',
        enum: ['append', 'overwrite'],
      },
      baseVersion: {
        type: 'string',
        description: 'Optional version returned by wiki_read. When provided, the write fails if the note changed since that read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          mode: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const mode = args.mode ?? 'append'
      await mkdir(vaultRoot, { recursive: true })
      const absolutePath = await containedPathReal(vaultRoot, args.id)
      const hasExtension = resolved.extensions.some(ext => args.id.endsWith(dottedExtension(ext)))
      if (!hasExtension) {
        throw new Error(`tool-memory-filesystem: note id must end with one of ${resolved.extensions.join(', ')}`)
      }
      await mkdir(dirname(absolutePath), { recursive: true })
      await containedPathReal(vaultRoot, args.id)
      exec.signal.throwIfAborted()
      let existing: string | undefined
      try {
        existing = await readFile(absolutePath, 'utf8')
      } catch {
        // file does not exist yet
      }
      if (args.baseVersion !== undefined && noteVersion(existing ?? '') !== args.baseVersion) {
        throw new Error(`tool-memory-filesystem: note ${args.id} changed since it was read; re-read it before writing`)
      }
      let finalBody: string
      if (mode === 'overwrite') {
        finalBody = normalizeTextTimestamps(args.content)
      } else {
        const { frontmatter, body } = splitFrontmatter(existing ?? '')
        normalizeNoteTimestamps(frontmatter)
        const timestamp = formatBeijingTime(new Date())
        // Track note lifetime the way memory_capture does: `created` on the
        // first write, `updated` on every append thereafter.
        if (existing === undefined) {
          frontmatter.created ??= timestamp
        } else {
          frontmatter.updated = timestamp
        }
        const frontmatterText = Object.keys(frontmatter).length > 0
          ? `---\n${yaml.dump(frontmatter).trim()}\n---\n\n`
          : ''
        // Content that opens with its own heading supplies the section
        // header, so a bare `## <time>` above it would duplicate it.
        const header = args.content.trimStart().startsWith('#') ? '' : `## ${timestamp}\n\n`
        const base = `${frontmatterText}${body}`.replace(/\s+$/, '')
        finalBody = base === '' ? `${header}${args.content}\n` : `${base}\n\n${header}${args.content}\n`
      }
      exec.signal.throwIfAborted()
      await writeAtomic(absolutePath, finalBody)
      const info = await stat(absolutePath)
      recordMtime(absolutePath, info.mtimeMs)
      return { id: vaultRelativeId(vaultRoot, absolutePath), mode, bytes: Buffer.byteLength(finalBody, 'utf8') }
    },
  })))
}
