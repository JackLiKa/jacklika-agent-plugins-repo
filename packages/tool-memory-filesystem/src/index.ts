/**
 * Model-facing wiki/memory tools over a local Markdown vault. The package
 * provides `wiki_read`, `wiki_search`, and `wiki_write` so an agent can treat a
 * directory of Markdown notes as long-term memory. Notes are plain files with
 * YAML frontmatter and Obsidian-style `[[link]]` references; the agent reads,
 * searches, and appends notes through the tool registry without touching core
 * packages.
 * @module @jacklika/dsh-tool-memory-filesystem
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { formatBeijingTime } from '@jacklika/dsh-memory-time'
import yaml from 'js-yaml'
import { codeUnitCompare, fuseRankings, rankNotes } from './search.ts'
import type { IndexedNote, Note } from './types.ts'

export type * from './types.ts'

const execFileAsync = promisify(execFile)

/** Top-level archive directory for forgotten/archived notes. */
const ARCHIVE_DIR = 'archive'

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
  /**
   * Top-level directory names to exclude from indexing. The archive directory
   * (`archive`) is excluded by default so forgotten notes do not pollute
   * search/graph results; explicit `wiki_read` calls can still retrieve them.
   */
  excludeDirs?: string[]
  bundleName?: string
  bundleVersion?: string
}

/** Schemastery configuration for the filesystem memory tool consumer. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().default(''),
  extensions: z.array(z.string()).default(['.md']),
  maxLinkDepth: z.number().default(1),
  maxSearchResults: z.number().default(20),
  indexHiddenDirs: z.boolean().default(false),
  excludeDirs: z.array(z.string()).default(['archive']),
  bundleName: z.string().default(''),
  bundleVersion: z.string().default(''),
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

async function runtimePackageIdentity(): Promise<{ name: string; version: string; modulePath: string; moduleFingerprint: string }> {
  const text = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const value = JSON.parse(text) as { name?: unknown; version?: unknown }
  if (typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error('tool-memory-filesystem: package identity is invalid')
  }
  const modulePath = fileURLToPath(import.meta.url)
  const moduleBytes = await readFile(modulePath)
  return {
    name: value.name,
    version: value.version,
    modulePath,
    moduleFingerprint: createHash('sha256').update(moduleBytes).digest('hex'),
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
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
  if (candidate.includes('\0')) {
    throw new Error('tool-memory-filesystem: note id must not contain a NUL byte')
  }
  // A backslash is a path separator only on Windows; the same id would name
  // different files per platform. Note ids always use '/', matching the id
  // rules the scope and curator plugins already enforce.
  if (candidate.includes('\\')) {
    throw new Error(`tool-memory-filesystem: note id ${JSON.stringify(candidate)} must not contain a backslash; use "/" as the path separator`)
  }
  const absoluteRoot = resolve(root)
  const absolute = resolve(absoluteRoot, candidate)
  const remainder = relative(absoluteRoot, absolute)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`tool-memory-filesystem: path ${JSON.stringify(candidate)} is outside the vault root`)
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
        throw new Error(`tool-memory-filesystem: path ${JSON.stringify(candidate)} resolves outside the vault root`)
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
 * `---\n...\n---\n` form is recognized, optionally behind a UTF-8 BOM.
 * Duplicate keys resolve last-one-wins rather than dropping the block.
 * @param text - raw file contents.
 * @returns frontmatter map and body.
 */
export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  // A UTF-8 BOM is invisible but pushes the opening fence off the start of the
  // string, which would silently drop the whole frontmatter block.
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source)
  if (match === null) {
    return { frontmatter: {}, body: text }
  }
  const frontmatterText = match[1] ?? ''
  const bodyText = match[2] ?? ''
  try {
    // `json: true` makes duplicate keys last-one-wins instead of throwing;
    // throwing falls into the catch below and drops every field.
    const parsed = yaml.load(frontmatterText, { json: true })
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
 * Test whether a note's optional `expires` frontmatter has passed. Unparseable
 * or absent values are treated as "not expired" so a typo never disappears a
 * note. Dates are compared in UTC to avoid local-clock surprises.
 */
export function isExpired(frontmatter: Record<string, unknown>): boolean {
  const value = frontmatter.expires
  if (typeof value !== 'string' || value === '') return false
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return false
  return parsed.getTime() < Date.now()
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
  // Link targets stay lenient where ids are strict: the resolver looks targets
  // up rather than addressing files, so Windows-style separators normalize to
  // '/' the same way {@link createLinkResolver} does. Percent-encoding is not
  // decoded on either path, so `%2e%2e` is a literal name, never an escape.
  const normalized = target.replace(/\\/g, '/')
  if (resolve !== undefined) {
    const id = resolve(normalized)
    if (id !== undefined) return containedPathReal(root, id)
  }
  const candidates = extensions.map(ext => `${normalized}${dottedExtension(ext)}`)
  candidates.push(normalized)
  for (const candidate of candidates) {
    // A NUL byte can never name a real note; skip it instead of aborting the
    // whole read over one malformed link.
    if (candidate.includes('\0')) continue
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
 * @param onSkip - optional callback for entries skipped because they could not
 *   be read; one unreadable directory must not fail the whole vault scan.
 * @returns absolute paths of every note file.
 */
export async function listNotePaths(
  root: string,
  extensions: string[],
  indexHiddenDirs = false,
  onSkip?: (path: string, error: unknown) => void,
  excludeDirs?: string[],
): Promise<string[]> {
  const results: string[] = []
  const exclude = new Set(['.git', 'node_modules', '.obsidian', ...(excludeDirs ?? [])])

  try {
    if (!(await stat(root)).isDirectory()) return results
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return results
    throw err
  }

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      // An unreadable directory hides only its own subtree.
      onSkip?.(dir, error)
      return
    }
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
  // Only exclude top-level directories; nested directories named `archive` are
  // still indexed so a legitimate note directory deeper in the vault is not
  // silently hidden.
  for (const name of excludeDirs ?? []) {
    exclude.add(name)
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
 * @param onSkip - optional callback for notes skipped because they could not
 *   be read; one unreadable note must not fail search for the whole vault.
 * @returns a map from note id to search result.
 */
export async function buildIndex(
  root: string,
  extensions: string[],
  indexHiddenDirs = false,
  onSkip?: (path: string, error: unknown) => void,
  excludeDirs?: string[],
): Promise<Map<string, IndexedNote>> {
  const paths = await listNotePaths(root, extensions, indexHiddenDirs, onSkip, excludeDirs)
  const notes: Note[] = []
  for (const path of paths) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      onSkip?.(path, error)
      continue
    }
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
    const explicitTitle = typeof note.frontmatter.title === 'string' ? note.frontmatter.title.trim() : ''
    const headingMatch = /^#\s+(.+)$/m.exec(note.body)
    const title = explicitTitle !== ''
      ? explicitTitle
      : (headingMatch !== null && headingMatch[1] !== undefined
        ? headingMatch[1].trim()
        : note.id.replace(/\.[^.]+$/, ''))
    index.set(note.id, { id: note.id, title, backlinks: [], body: note.body, frontmatter: note.frontmatter })
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
  // rename replaces the inode, so carry an existing target's permission bits
  // onto the staged file; otherwise a read-only note silently becomes writable.
  let mode: number | undefined
  try {
    mode = (await stat(absolutePath)).mode & 0o7777
  } catch {
    // New note: keep the default creation mode.
  }
  try {
    await writeFile(tmpPath, contents, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) })
    if (mode !== undefined) await chmod(tmpPath, mode)
    await rename(tmpPath, absolutePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Turn a filesystem failure into a structured, vault-relative tool error. Raw
 * Node errors carry absolute host paths and no plugin context; callers see
 * `tool-memory-filesystem: cannot read note "x.md": permission denied` instead.
 */
function noteIoError(action: 'read' | 'write', id: string, error: unknown): Error {
  return new Error(`tool-memory-filesystem: cannot ${action} note ${JSON.stringify(id)}: ${describeIoError(error)}`)
}

/** Short, host-path-free description of one filesystem error. */
function describeIoError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return 'no such note'
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied'
  if (code === 'EISDIR') return 'path is a directory'
  if (typeof code === 'string' && code !== '') return code
  return error instanceof Error ? error.message : String(error)
}

/**
 * Follow a symlink at the final path component so a write publishes through
 * the link instead of replacing it: the sibling-temp + rename sequence targets
 * the directory entry itself, which would otherwise turn an alias note into a
 * regular file and leave the linked note untouched.
 */
async function resolveSymlinkWriteTarget(root: string, absolutePath: string, id: string): Promise<string> {
  const info = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw noteIoError('write', id, error)
  })
  if (info === undefined || !info.isSymbolicLink()) return absolutePath
  const canonical = await realpath(absolutePath).catch(() => {
    // A broken link cannot be written through; replacing it would silently
    // discard the alias, so refuse instead.
    throw new Error(`tool-memory-filesystem: cannot write through broken symbolic link ${JSON.stringify(id)}`)
  })
  const canonicalRoot = await realpath(resolve(root))
  const remainder = relative(canonicalRoot, canonical)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`tool-memory-filesystem: path ${JSON.stringify(id)} resolves outside the vault root`)
  }
  return canonical
}

/** Build the skip callback that reports unreadable entries to the Loader logger. */
function skipLogger(ctx: Context, root: string): (path: string, error: unknown) => void {
  return (path, error) => {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    ctx.logger?.warn(`tool-memory-filesystem: skipped unreadable entry ${vaultRelativeId(root, path)} (${code})`)
  }
}

/** Validate that at least one note extension is configured. */
function assertExtensions(extensions: string[]): void {
  if (extensions.length === 0) {
    throw new Error('tool-memory-filesystem: extensions must list at least one file extension')
  }
}

/** Validate a positive-integer config bound. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-memory-filesystem: ${name} must be a positive integer`)
  }
}

function foldSearchTitle(title: string): string {
  return title.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
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
  assertExtensions(resolved.extensions)

  const vaultRootFor = (exec: ToolRunContext): string => resolveMemoryVaultRoot(resolved.vaultRoot, exec)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_runtime_info',
    description: 'Return a read-only runtime identity and write preflight for the current DSH session, resolved workspace, memory vault, loaded filesystem component, configured bundle, and profile hint. Supply expectedCwd and expectedVaultRoot before any acceptance-test write; safeToWrite is false when either expectation is absent or mismatched.',
    parameters: {
      expectedCwd: {
        type: 'string',
        description: 'Absolute workspace path the caller intends to test.',
      },
      expectedVaultRoot: {
        type: 'string',
        description: 'Absolute resolved vault path the caller intends to write.',
      },
      expectedProfile: {
        type: 'string',
        description: 'Optional DSH profile name expected from the host environment.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const sessionCwd = resolve(exec.agent?.session.header.cwd ?? process.cwd())
      const cwdSource = exec.agent?.session.header.cwd === undefined ? 'process' : 'session'
      const vaultRoot = resolve(vaultRootFor(exec))
      const expectedCwdInput = typeof args.expectedCwd === 'string' ? args.expectedCwd : undefined
      const expectedVaultRootInput = typeof args.expectedVaultRoot === 'string' ? args.expectedVaultRoot : undefined
      const expectedCwd = expectedCwdInput !== undefined && isAbsolute(expectedCwdInput) ? resolve(expectedCwdInput) : undefined
      const expectedVaultRoot = expectedVaultRootInput !== undefined && isAbsolute(expectedVaultRootInput) ? resolve(expectedVaultRootInput) : undefined
      const expectedProfile = typeof args.expectedProfile === 'string' ? args.expectedProfile : undefined
      const profileName = process.env.DSH_PROFILE ?? null
      const mismatches: string[] = []
      if (expectedCwdInput === undefined) mismatches.push('expectedCwd is required')
      else if (expectedCwd === undefined) mismatches.push('expectedCwd must be absolute')
      else if (expectedCwd !== sessionCwd) mismatches.push('session cwd does not match expectedCwd')
      if (expectedVaultRootInput === undefined) mismatches.push('expectedVaultRoot is required')
      else if (expectedVaultRoot === undefined) mismatches.push('expectedVaultRoot must be absolute')
      else if (expectedVaultRoot !== vaultRoot) mismatches.push('resolved vault root does not match expectedVaultRoot')
      if (expectedProfile !== undefined && expectedProfile !== profileName) {
        mismatches.push('host profile does not match expectedProfile')
      }
      const component = await runtimePackageIdentity()
      const bundle = resolved.bundleName === '' || resolved.bundleVersion === ''
        ? null
        : { name: resolved.bundleName, version: resolved.bundleVersion }
      const identity = {
        schemaVersion: 1,
        component,
        bundle,
        profile: { name: profileName, source: profileName === null ? 'unavailable' : 'environment' },
        session: { cwd: sessionCwd, cwdSource, agentId: exec.agent?.id ?? null },
        vault: {
          configuredRoot: resolved.vaultRoot === '' ? null : resolved.vaultRoot,
          resolvedRoot: vaultRoot,
          exists: await pathExists(vaultRoot),
          gitRepository: await pathExists(join(vaultRoot, '.git')),
        },
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
      return {
        ...identity,
        preflight: {
          safeToWrite: mismatches.length === 0,
          expectedCwd: expectedCwd ?? null,
          expectedVaultRoot: expectedVaultRoot ?? null,
          expectedProfile: expectedProfile ?? null,
          mismatches,
        },
        fingerprint,
      } as unknown as JsonValue
    },
  })))

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
        .catch(error => {
          // A vault whose root does not exist yet simply holds no such note.
          // An errno failure always carries an absolute host path in its raw
          // message, so it is rewritten; a containment or id rejection has no
          // errno and keeps its own message.
          if ((error as NodeJS.ErrnoException).code !== undefined) throw noteIoError('read', args.id, error)
          throw error
        })
      const linkResolver = createLinkResolver(
        (await listNotePaths(vaultRoot, resolved.extensions, resolved.indexHiddenDirs, skipLogger(ctx, vaultRoot), resolved.excludeDirs))
          .map(path => vaultRelativeId(vaultRoot, path)),
      )
      const note = await readNote(vaultRoot, resolved.extensions, resolved.maxLinkDepth, absolutePath, new Set(), linkResolver)
        .catch(error => { throw noteIoError('read', args.id, error) })
      const info = await stat(absolutePath).catch(error => { throw noteIoError('read', args.id, error) })
      return {
        ...note,
        expired: isExpired(note.frontmatter),
        mtime: formatBeijingTime(info.mtime),
        modifiedExternally: detectExternalChange(absolutePath, info.mtimeMs),
      } as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_search',
    description: 'Search the wiki vault by note title or body keyword. Terms are OR-matched and ranked by relevance. Optional exactTitle instead matches folded titles across the full vault before applying the result cap, without semantic ranking; use it to check for an exact title independently of broad keyword hits. Returns { hits, total, truncated }: each hit carries id, title, score, and backlinks; total counts matches before the cap.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keyword or phrase to match against note titles and bodies.',
      },
      exactTitle: {
        type: 'string',
        description: 'Optional exact title lookup across the full vault, using NFC case folding and collapsed separators instead of ranked keyword matching. Results retain the usual cap and total count.',
      },
      maxResults: {
        type: 'integer',
        description: 'Optional per-call result cap; overrides the configured maxSearchResults. Use sparingly for bulk scans that would otherwise be truncated.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                score: { type: 'number' },
                backlinks: { type: 'array', items: { type: 'string' } },
                expired: { type: 'boolean' },
              },
            },
          },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          fused: { type: 'boolean' },
          semantic: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const index = await buildIndex(vaultRoot, resolved.extensions, resolved.indexHiddenDirs, skipLogger(ctx, vaultRoot), resolved.excludeDirs)
      const resultCap = typeof args.maxResults === 'number' && Number.isInteger(args.maxResults) && args.maxResults >= 1
        ? args.maxResults
        : resolved.maxSearchResults
      if (args.exactTitle !== undefined) {
        const folded = foldSearchTitle(args.exactTitle)
        const exact = folded === '' ? [] : [...index.values()]
          .filter(note => foldSearchTitle(note.title) === folded)
          .sort((a, b) => codeUnitCompare(a.id, b.id))
        const hits = exact.slice(0, resultCap)
          .map(note => ({ id: note.id, title: note.title, score: 1, backlinks: note.backlinks, expired: isExpired(note.frontmatter) }))
        return { hits, total: exact.length, truncated: hits.length < exact.length, fused: false, semantic: 'unavailable' }
      }
      let hits = rankNotes(index, args.query)
      // Optional semantic layer: when `wiki_semantic_search` is mounted, fuse
      // both rankings via reciprocal rank fusion. Only the dispatch is
      // fail-soft — an unavailable or erroring semantic layer degrades to the
      // lexical ranking; parse/fusion errors propagate so real bugs surface
      // instead of silently weakening results.
      let semantic: 'ok' | 'unavailable' | 'error' = 'unavailable'
      let fused = false
      if (ctx.tools.get('wiki_semantic_search') !== undefined) {
        let semanticResult
        try {
          semanticResult = await ctx.tools.execute({
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
          semantic = 'error'
        }
        if (semanticResult !== undefined && !semanticResult.isError) {
          try {
            const semanticHits = JSON.parse(
              semanticResult.content
                .map(block => {
                  const maybe = block as { type?: unknown; text?: unknown }
                  return maybe.type === 'text' && typeof maybe.text === 'string' ? maybe.text : ''
                })
                .join('') || '[]',
            ) as { id: string }[]
            hits = fuseRankings(hits, semanticHits.map(hit => hit.id), index)
            semantic = 'ok'
            fused = true
          } catch (error) {
            ctx.logger?.warn('tool-memory-filesystem: semantic fusion skipped: ' + String(error))
            semantic = 'error'
          }
        } else if (semanticResult !== undefined) {
          ctx.logger?.warn('tool-memory-filesystem: semantic fusion skipped: wiki_semantic_search returned an error')
          semantic = 'error'
        }
      }
      const capped = hits.slice(0, resultCap)
        .map(note => ({ id: note.id, title: note.title, score: note.score, backlinks: note.backlinks, expired: isExpired(index.get(note.id)?.frontmatter ?? {}) }))
      return { hits: capped, total: hits.length, truncated: capped.length < hits.length, fused, semantic }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_history',
    description: 'Return the git commit history of one note as a list of commits, newest first. Each entry carries the commit hash, author timestamp, message, and author name. The commit hashes can be passed to wiki_restore to roll the note forward to an earlier version without rewriting git history. Requires a git repository inside the vault.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Vault-relative path of the note whose history to read.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of commits to return; defaults to 50.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          commits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hash: { type: 'string' },
                date: { type: 'string' },
                message: { type: 'string' },
                author: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      await containedPathReal(vaultRoot, args.id).catch(error => { throw noteIoError('read', args.id, error) })
      const hasGit = await stat(join(vaultRoot, '.git')).then(() => true, () => false)
      if (!hasGit) throw new Error(`tool-memory-filesystem: no git repository in vault; cannot read history for ${JSON.stringify(args.id)}`)
      const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50
      const { stdout } = await execFileAsync('git', ['-C', vaultRoot, 'log', `--max-count=${limit}`, '--format=%H%x00%ai%x00%an%x00%s', '--', args.id])
        .catch(error => { throw new Error(`tool-memory-filesystem: cannot read history for ${JSON.stringify(args.id)}: ${error instanceof Error ? error.message : String(error)}`) })
      const commits = stdout.trim().split('\n').filter(line => line.trim() !== '').map(line => {
        const [hash, date, author, ...messageParts] = line.split('\0')
        return {
          hash: hash ?? '',
          date: date ?? '',
          author: author ?? '',
          message: messageParts.join('\0'),
        }
      })
      return { commits }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_restore',
    description: 'Restore one note to the content it had at a specific git commit hash. The current note must still exist and its version must match baseVersion. When memory-git handles wiki_restore, it records a new forward commit without rewriting history; otherwise the result is an uncommitted working-tree write. Returns { id, restoredFrom, version, committed? }.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Vault-relative path of the note to restore.',
      },
      hash: {
        type: 'string',
        required: true,
        description: 'Git commit hash returned by wiki_history for this note.',
      },
      baseVersion: {
        type: 'string',
        required: true,
        description: 'Current version from wiki_read; the restore fails if the note changed since it was read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          restoredFrom: { type: 'string' },
          version: { type: 'string' },
          committed: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const hasGit = await stat(join(vaultRoot, '.git')).then(() => true, () => false)
      if (!hasGit) throw new Error(`tool-memory-filesystem: no git repository in vault; cannot restore ${JSON.stringify(args.id)}`)
      const absolutePath = await containedPathReal(vaultRoot, args.id).catch(error => { throw noteIoError('read', args.id, error) })
      const current = await readFile(absolutePath, 'utf8').catch(error => { throw noteIoError('read', args.id, error) })
      if (noteVersion(current) !== args.baseVersion) {
        throw new Error(`tool-memory-filesystem: note ${JSON.stringify(args.id)} changed since it was read; re-read it before restoring`)
      }
      const { stdout } = await execFileAsync('git', ['-C', vaultRoot, 'show', `${args.hash}:${args.id}`])
        .catch(error => { throw new Error(`tool-memory-filesystem: cannot restore ${JSON.stringify(args.id)} from ${args.hash}: ${error instanceof Error ? error.message : String(error)}`) })
      await writeAtomic(absolutePath, stdout).catch(error => { throw noteIoError('write', args.id, error) })
      const info = await stat(absolutePath).catch(error => { throw noteIoError('read', args.id, error) })
      recordMtime(absolutePath, info.mtimeMs)
      return {
        id: args.id,
        restoredFrom: args.hash,
        version: noteVersion(stdout),
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Archive one note by moving it from its current id to archive/<id>. The note remains readable via wiki_read by its archived id and remains in git history; it is excluded from default wiki_search and wiki_graph results. Requires the note id and the version returned by wiki_read; a changed note is refused. Returns { forgotten, id, archivedTo, version, created, updated, committed }.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Vault-relative path of the note to archive (e.g. "shared/notes/decision.md").',
      },
      baseVersion: {
        type: 'string',
        required: true,
        description: 'Version from wiki_read; the archive fails if the note changed since it was read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgotten: { type: 'boolean' },
          id: { type: 'string' },
          archivedTo: { type: 'string' },
          version: { type: 'string' },
          created: { type: 'string' },
          updated: { type: 'string' },
          committed: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const absolutePath = await containedPathReal(vaultRoot, args.id)
        .catch(error => { throw noteIoError('read', args.id, error) })
      const text = await readFile(absolutePath, 'utf8').catch(error => { throw noteIoError('read', args.id, error) })
      if (noteVersion(text) !== args.baseVersion) {
        throw new Error(`tool-memory-filesystem: note ${JSON.stringify(args.id)} changed since it was read; re-read it before forgetting`)
      }
      const archivedTo = `${ARCHIVE_DIR}/${args.id}`
      const archiveAbsolute = await containedPathReal(vaultRoot, archivedTo).catch(error => { throw noteIoError('read', archivedTo, error) })
      try {
        await stat(archiveAbsolute)
        throw new Error(`tool-memory-filesystem: archived note ${JSON.stringify(archivedTo)} already exists; refusing to overwrite`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw noteIoError('write', archivedTo, error)
      }
      const { frontmatter, body } = splitFrontmatter(text)
      const archivedFrontmatter: Record<string, unknown> = { ...frontmatter, archived: formatBeijingTime(new Date()), archivedFrom: args.id }
      normalizeNoteTimestamps(archivedFrontmatter)
      const archivedText = Object.keys(archivedFrontmatter).length > 0
        ? `---\n${yaml.dump(archivedFrontmatter).trim()}\n---\n${body}`
        : text
      const archiveDir = dirname(archiveAbsolute)
      await mkdir(archiveDir, { recursive: true }).catch(error => { throw noteIoError('write', archivedTo, error) })
      await writeAtomic(archiveAbsolute, archivedText).catch(error => { throw noteIoError('write', archivedTo, error) })
      await rm(absolutePath).catch(error => { throw noteIoError('write', args.id, error) })
      const result: Record<string, unknown> = {
        forgotten: true,
        id: args.id,
        archivedTo,
        version: noteVersion(archivedText),
      }
      if (typeof archivedFrontmatter.created === 'string' && archivedFrontmatter.created !== '') result.created = archivedFrontmatter.created
      if (typeof archivedFrontmatter.updated === 'string' && archivedFrontmatter.updated !== '') result.updated = archivedFrontmatter.updated
      return result
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_write',
    description: 'Create a new note or append to an existing note in the wiki vault. The path is relative to the vault root. When appending, the new content is inserted at the end of the body after a timestamp header. Set requireExisting to update a note that must already exist: the write then fails instead of creating a new note. Returns { id, mode, bytes, version }, where version fingerprints the written content and can be passed as baseVersion on the next write without reading the note again.',
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
        description: 'Optional version returned by wiki_read or by an earlier wiki_write. When provided, the write fails if the note changed since that version.',
      },
      requireExisting: {
        type: 'boolean',
        description: 'Refuse to create the note: the write must target an existing note. Use this for update-only writes, where a missing note means the caller addressed the wrong id rather than intending a new note.',
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
          version: { type: 'string' },
          created: { type: 'string' },
          updated: { type: 'string' },
          committed: { type: 'boolean' },
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
      const writeTarget = await resolveSymlinkWriteTarget(vaultRoot, absolutePath, args.id)
      let existing: string | undefined
      try {
        existing = await readFile(writeTarget, 'utf8')
      } catch (error) {
        // Only a missing file means a first write; any other failure (a
        // directory in the way, an unreadable note) must not silently fall
        // back to treating the note as new and replacing it.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw noteIoError('write', args.id, error)
      }
      if (existing === undefined && args.requireExisting === true) {
        throw new Error(`tool-memory-filesystem: note ${JSON.stringify(args.id)} does not exist; refusing to create it`)
      }
      // Parents are created only after the existence rules passed, so a
      // refused update leaves no empty directory behind.
      try {
        await mkdir(dirname(writeTarget), { recursive: true })
      } catch (error) {
        throw noteIoError('write', args.id, error)
      }
      await containedPathReal(vaultRoot, args.id)
      exec.signal.throwIfAborted()
      if (args.baseVersion !== undefined && noteVersion(existing ?? '') !== args.baseVersion) {
        throw new Error(`tool-memory-filesystem: note ${args.id} changed since it was read; re-read it before writing`)
      }
      let finalBody: string
      let frontmatter: Record<string, unknown> = {}
      if (mode === 'overwrite') {
        finalBody = normalizeTextTimestamps(args.content)
        frontmatter = splitFrontmatter(finalBody).frontmatter
      } else {
        const split = splitFrontmatter(existing ?? '')
        frontmatter = split.frontmatter
        const body = split.body
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
      await writeAtomic(writeTarget, finalBody)
        .catch(error => { throw noteIoError('write', args.id, error) })
      const info = await stat(writeTarget)
      recordMtime(absolutePath, info.mtimeMs)
      const result: Record<string, unknown> = {
        id: vaultRelativeId(vaultRoot, absolutePath),
        mode,
        bytes: Buffer.byteLength(finalBody, 'utf8'),
        // `writeAtomic` publishes `finalBody` verbatim, so this is the same
        // fingerprint `wiki_read` would report — without a second read.
        version: noteVersion(finalBody),
      }
      if (typeof frontmatter.created === 'string' && frontmatter.created !== '') result.created = frontmatter.created
      if (typeof frontmatter.updated === 'string' && frontmatter.updated !== '') result.updated = frontmatter.updated
      return result
    },
  })))
}
