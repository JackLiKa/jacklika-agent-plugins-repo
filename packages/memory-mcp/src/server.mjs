#!/usr/bin/env node
/**
 * @jacklika/dsh-memory-mcp — an MCP stdio server exposing the memory vault to
 * any MCP client. Each server serializes its own requests and coordinates
 * same-note writes with dsh through the vault's per-note lock directories.
 *
 * Usage: dsh-memory-mcp [--vault <path>] [--max-link-depth N] [--notes-dir DIR]
 *   --vault defaults to <cwd>/.plugins/memory/ to match the Bundle default.
 *   --notes-dir is the shared curated zone for memory_capture; it defaults to
 *   shared/notes, the memory-curator default.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { formatBeijingTime } from '@jacklika/dsh-memory-time'
import yaml from 'js-yaml'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'dsh-memory-mcp', version: '0.1.0' }

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function argValue(flag, fallback) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const VAULT = resolve(argValue('--vault', join(process.cwd(), '.plugins', 'memory')))
const MAX_LINK_DEPTH = Number(argValue('--max-link-depth', '1'))
const NOTES_DIR = (argValue('--notes-dir', 'shared/notes') || 'shared/notes').replace(/\/+$/, '')
const EXTENSIONS = ['.md']
const MAX_SEARCH_RESULTS = 20
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.obsidian', 'archive'])

/** Return a POSIX-style vault-relative id from an absolute path. */
function vaultRelativeId(absolutePath) {
  return relative(VAULT, absolutePath).replace(/\\/g, '/')
}

/**
 * Describe an fs error without its path: raw Node error messages carry the
 * absolute vault path (or a temp file name), which must not reach clients.
 * Node fs errors always carry a `code`, so the fallback stays path-free too.
 */
function describeIoError(error) {
  const code = error?.code
  if (code === 'ENOENT') return 'no such note'
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied'
  if (code === 'EISDIR') return 'path is a directory'
  return typeof code === 'string' && code !== '' ? code : 'unknown error'
}

function noteIoError(action, id, error) {
  return new Error(`memory-mcp: cannot ${action} note ${JSON.stringify(id)}: ${describeIoError(error)}`)
}

// ── Vault operations (mirrors @jacklika/dsh-tool-memory-filesystem) ──────────

function containedPath(candidate) {
  if (candidate.includes('\0')) {
    throw new Error('memory-mcp: note id must not contain a NUL byte')
  }
  // A backslash is a path separator only on Windows; ids always use '/', the
  // same rule the scope, curator, and filesystem plugins enforce.
  if (candidate.includes('\\')) {
    throw new Error(`memory-mcp: note id ${JSON.stringify(candidate)} must not contain a backslash; use "/" as the path separator`)
  }
  const absolute = resolve(VAULT, candidate)
  const remainder = relative(VAULT, absolute)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`memory-mcp: path ${JSON.stringify(candidate)} is outside the vault root`)
  }
  return absolute
}

async function containedPathReal(candidate) {
  const absolute = containedPath(candidate)
  const canonicalRoot = await realpath(VAULT)
  let ancestor = absolute
  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor)
      const remainder = relative(canonicalRoot, canonicalAncestor)
      if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
        throw new Error(`memory-mcp: path ${JSON.stringify(candidate)} resolves outside the vault root`)
      }
      return absolute
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
}

// Mirrors splitFrontmatter in @jacklika/dsh-tool-memory-filesystem so notes
// written by external editors (CRLF, unquoted timestamps, YAML lists) read
// the same through MCP as through the dsh tools.
function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (match === null) return { frontmatter: {}, body: text }
  const frontmatterText = match[1] ?? ''
  const bodyText = match[2] ?? ''
  try {
    const parsed = yaml.load(frontmatterText)
    const frontmatter = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value instanceof Date) frontmatter[key] = formatBeijingTime(value)
    }
    return { frontmatter, body: bodyText }
  } catch {
    return { frontmatter: {}, body: text }
  }
}

function noteVersion(text) {
  return createHash('sha1').update(text).digest('hex')
}

function isExpired(frontmatter) {
  const value = frontmatter?.expires
  if (typeof value !== 'string' || value === '') return false
  const parsed = new Date(value).getTime()
  return !Number.isNaN(parsed) && parsed < Date.now()
}

// Mirrors the mtime tracking and timestamp normalization in
// @jacklika/dsh-tool-memory-filesystem so MCP clients see the same
// modifiedExternally flag and +08:00 write normalization as the dsh tools.
const observedMtimes = new Map()
const OBSERVED_MTIME_LIMIT = 256

function recordMtime(path, mtimeMs) {
  observedMtimes.delete(path)
  observedMtimes.set(path, mtimeMs)
  if (observedMtimes.size > OBSERVED_MTIME_LIMIT) {
    const oldest = observedMtimes.keys().next().value
    if (oldest !== undefined) observedMtimes.delete(oldest)
  }
}

function detectExternalChange(path, mtimeMs) {
  const seen = observedMtimes.get(path)
  recordMtime(path, mtimeMs)
  return seen !== undefined && seen !== mtimeMs
}

function normalizeNoteTimestamps(frontmatter) {
  for (const key of ['created', 'updated']) {
    const value = frontmatter[key]
    if (typeof value !== 'string') continue
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) continue
    const normalized = formatBeijingTime(parsed)
    if (normalized !== value) frontmatter[key] = normalized
  }
}

function normalizeTextTimestamps(text) {
  const { frontmatter, body } = splitFrontmatter(text)
  if (Object.keys(frontmatter).length === 0) return text
  normalizeNoteTimestamps(frontmatter)
  return `---\n${yaml.dump(frontmatter).trim()}\n---\n${body}`
}

function extractLinks(text) {
  const links = []
  for (const m of stripCode(text).matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) links.push(m[1].trim())
  return links
}

/**
 * Remove fenced code blocks and inline code spans so literal `[[...]]` inside
 * them is not treated as a link. Fences follow CommonMark: a closing fence
 * must use the same marker character and be at least as long as the opener —
 * a rule a regex backreference cannot express, so fences are scanned line by
 * line. Inline spans treat backtick runs as maximal units: a run closes only
 * at a later run of exactly equal length; an unmatched run is literal text.
 */
function stripCode(text) {
  const kept = []
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

async function listNotePaths(dir = VAULT) {
  const results = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) results.push(...await listNotePaths(full))
    else if (entry.isFile() && EXTENSIONS.some(ext => entry.name.endsWith(ext))) results.push(full)
  }
  return results
}

/**
 * Build a resolver over the known note ids, matching Obsidian semantics: an
 * exact vault-relative path first, then a path-suffix match, then a bare
 * basename match — each tier tolerates the target carrying or omitting the
 * extension. Ambiguity within a tier resolves to the id with the fewest path
 * segments, ties by code-unit order, so results are identical across hosts.
 */
function createLinkResolver(ids) {
  const entries = ids.map(id => {
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
  const exact = new Map()
  const suffix = new Map()
  const basename = new Map()
  const add = (table, key, entry) => {
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
  const pick = matches => {
    if (matches === undefined || matches.length === 0) return undefined
    matches.sort((a, b) => a.segments - b.segments || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return matches[0].id
  }
  return target => {
    const t = target.replace(/\\/g, '/')
    return pick(exact.get(t)) ?? pick(suffix.get(t)) ?? pick(basename.get(t))
  }
}

async function vaultLinkResolver() {
  return createLinkResolver((await listNotePaths()).map(p => vaultRelativeId(p)))
}

async function resolveLinkTarget(link, resolve) {
  // Link targets stay lenient where ids are strict: Windows-style separators
  // normalize to '/', and percent-encoding is never decoded, so `%2e%2e` is a
  // literal name rather than an escape.
  const normalized = String(link).replace(/\\/g, '/')
  if (resolve !== undefined) {
    const id = resolve(normalized)
    if (id !== undefined) return containedPathReal(id)
  }
  for (const candidate of [normalized, ...EXTENSIONS.map(ext => `${normalized}${ext}`)]) {
    try {
      const p = await containedPathReal(candidate)
      await readFile(p, 'utf8')
      return p
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return undefined
}

async function readNote(absolutePath, depth, visited = new Set(), resolve) {
  const id = vaultRelativeId(absolutePath)
  if (visited.has(absolutePath)) {
    return { id, frontmatter: {}, body: '', links: [], version: '', linkedNotes: [] }
  }
  const next = new Set(visited)
  next.add(absolutePath)
  const text = await readFile(absolutePath, 'utf8')
  const { frontmatter, body } = splitFrontmatter(text)
  const links = extractLinks(text)
  const linkedNotes = []
  if (depth > 0) {
    resolve ??= await vaultLinkResolver()
    for (const link of links) {
      const target = await resolveLinkTarget(link, resolve)
      if (target !== undefined) linkedNotes.push(await readNote(target, depth - 1, next, resolve))
    }
  }
  return { id, frontmatter, body, links, version: noteVersion(text), linkedNotes, expired: isExpired(frontmatter) }
}

async function searchNotes(query, maxResults = MAX_SEARCH_RESULTS, exactTitle) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const folded = exactTitle === undefined ? undefined : foldTitle(exactTitle)
  const notes = []
  for (const path of await listNotePaths()) {
    const text = await readFile(path, 'utf8')
    const { frontmatter, body } = splitFrontmatter(text)
    const id = vaultRelativeId(path)
    const explicitTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : ''
    const headingMatch = /^#\s+(.+)$/m.exec(body)
    const title = explicitTitle !== ''
      ? explicitTitle
      : (headingMatch?.[1]?.trim() ?? id.replace(/\.[^.]+$/, ''))
    notes.push({ id, title, links: extractLinks(text), body })
  }
  const hits = notes.filter(n => {
    if (folded !== undefined) return folded !== '' && foldTitle(n.title) === folded
    const haystack = `${n.id} ${n.title} ${n.body}`.toLowerCase()
    return terms.every(t => haystack.includes(t))
  })
  hits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const total = hits.length
  const truncated = total > maxResults
  return {
    hits: hits.slice(0, maxResults).map(n => ({ id: n.id, title: n.title, score: 0, backlinks: [], expired: isExpired(n.frontmatter) })),
    total,
    truncated,
    fused: false,
    semantic: 'unavailable',
  }
}

async function acquireWriteLock(id) {
  const key = id.normalize('NFC').toLowerCase().replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '')
  const lockDir = join(VAULT, '.memory-queue.lock.lanes', `${createHash('sha1').update(key).digest('hex')}.lock`)
  await mkdir(VAULT, { recursive: true })
  await containedPathReal('.memory-queue.lock.lanes')
  await mkdir(dirname(lockDir), { recursive: true })
  await containedPathReal('.memory-queue.lock.lanes')
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw noteIoError('write', id, error)
      if (Date.now() >= deadline) throw new Error(`memory-mcp: timed out waiting for vault lock for ${JSON.stringify(id)}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  const token = randomUUID()
  const ownerPath = join(lockDir, 'owner.json')
  const heartbeatPath = join(lockDir, 'heartbeat')
  let timer
  try {
    await writeFile(ownerPath, JSON.stringify({ token, hostname: hostname(), pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
    await writeFile(heartbeatPath, '0', 'utf8')
    let counter = 0
    timer = setInterval(() => {
      counter += 1
      writeFile(heartbeatPath, String(counter), 'utf8').catch(() => undefined)
    }, 2000)
    timer.unref()
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true })
    throw noteIoError('write', id, error)
  }
  return async () => {
    clearInterval(timer)
    const owner = await readFile(ownerPath, 'utf8').then(text => {
      try { return JSON.parse(text) } catch { return null }
    }, () => null)
    if (owner?.token !== token) return
    const released = `${lockDir}.release-${token}`
    try {
      await rename(lockDir, released)
      await rm(released, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw noteIoError('write', id, error)
    }
  }
}

async function writeNote(id, content, mode = 'append', baseVersion, requireExisting = false) {
  if (typeof id !== 'string' || !EXTENSIONS.some(ext => id.endsWith(ext))) {
    throw new Error(`note id must end with one of ${EXTENSIONS.join(', ')}`)
  }
  const release = await acquireWriteLock(id)
  try {
    return await writeNoteUnlocked(id, content, mode, baseVersion, requireExisting)
  } finally {
    await release()
  }
}

async function writeNoteUnlocked(id, content, mode = 'append', baseVersion, requireExisting = false) {
  if (!EXTENSIONS.some(ext => id.endsWith(ext))) {
    throw new Error(`note id must end with one of ${EXTENSIONS.join(', ')}`)
  }
  await mkdir(VAULT, { recursive: true })
  const absolutePath = await containedPathReal(id)
  let existing
  try {
    existing = await readFile(absolutePath, 'utf8')
  } catch (error) {
    // Only a missing file means a first write; any other failure (a directory
    // in the way, an unreadable note) must not look like a new note.
    if (error?.code !== 'ENOENT') throw noteIoError('write', id, error)
  }
  if (existing === undefined && requireExisting) {
    throw new Error(`memory-mcp: note ${JSON.stringify(id)} does not exist; refusing to create it`)
  }
  // Parents are created only after the existence rules passed, so a refused
  // update leaves no empty directory behind.
  try {
    await mkdir(dirname(absolutePath), { recursive: true })
  } catch (error) {
    throw noteIoError('write', id, error)
  }
  await containedPathReal(id)
  if (baseVersion !== undefined && noteVersion(existing ?? '') !== baseVersion) {
    throw new Error(`note ${id} changed since it was read; re-read it before writing`)
  }
  let finalBody
  if (mode === 'overwrite') {
    finalBody = normalizeTextTimestamps(content)
  } else {
    const { frontmatter, body } = splitFrontmatter(existing ?? '')
    normalizeNoteTimestamps(frontmatter)
    const timestamp = formatBeijingTime(new Date())
    // Track note lifetime the same way the dsh tool does: `created` on the
    // first write, `updated` on every append thereafter.
    if (existing === undefined) {
      frontmatter.created ??= timestamp
    } else {
      frontmatter.updated = timestamp
    }
    const frontmatterText = Object.keys(frontmatter).length > 0
      ? `---\n${yaml.dump(frontmatter).trimEnd()}\n---\n\n`
      : ''
    // Content that opens with its own heading supplies the section header, so
    // a bare `## <time>` above it would duplicate it.
    const header = content.trimStart().startsWith('#') ? '' : `## ${timestamp}\n\n`
    const base = `${frontmatterText}${body}`.replace(/\s+$/, '')
    finalBody = base === '' ? `${header}${content}\n` : `${base}\n\n${header}${content}\n`
  }
  const tmp = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(tmp, finalBody, 'utf8')
    await rename(tmp, absolutePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw noteIoError('write', id, error)
  }
  recordMtime(absolutePath, (await stat(absolutePath)).mtimeMs)
  const { frontmatter } = splitFrontmatter(finalBody)
  const result = {
    id: vaultRelativeId(absolutePath),
    mode,
    bytes: Buffer.byteLength(finalBody, 'utf8'),
    version: noteVersion(finalBody),
  }
  if (typeof frontmatter.created === 'string' && frontmatter.created !== '') result.created = frontmatter.created
  if (typeof frontmatter.updated === 'string' && frontmatter.updated !== '') result.updated = frontmatter.updated
  return result
}

// ── memory_capture (mirrors @jacklika/dsh-memory-curator) ────────────────────

const MAX_SLUG_LENGTH = 100

/**
 * Fold a title to its comparison form exactly like the curator: NFC,
 * case-insensitive, every run of characters that are neither Unicode letters
 * nor digits collapsed to one space. Keeping `\p{L}` means CJK and other
 * non-Latin titles stay distinct instead of folding to one empty string.
 */
function foldTitle(title) {
  return title.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function hashTail(title, length = 12) {
  return createHash('sha256').update(title.normalize('NFC')).digest('hex').slice(0, length)
}

function slugify(title) {
  let slug = foldTitle(title).replace(/ /g, '-')
  // Symbol-only titles fold to nothing; a stable content hash keeps them
  // addressable and separate rather than sharing a bare ".md".
  if (slug === '') return `note-${hashTail(title)}`
  if (slug.length > MAX_SLUG_LENGTH) slug = `${slug.slice(0, 64)}-${hashTail(title)}`
  return slug
}

function isSafeNoteId(id) {
  if (id === '' || id.startsWith('/') || id.startsWith('\\') || /^[A-Za-z]:/.test(id)) return false
  if (id.includes('\\')) return false
  return !id.split('/').some(segment => segment === '..' || segment === '.')
}

function captureTargetId(explicitId, title) {
  if (typeof explicitId === 'string' && explicitId !== '') {
    const withExt = explicitId.endsWith('.md') ? explicitId : `${explicitId}.md`
    if (!isSafeNoteId(withExt)) {
      throw new Error(`memory_capture: invalid note id ${JSON.stringify(withExt)}: ids must be vault-relative paths without '..', '.', backslashes, leading slashes, or drive letters`)
    }
    return withExt.startsWith('shared/') ? withExt : `${NOTES_DIR}/${withExt}`
  }
  return `${NOTES_DIR}/${slugify(title)}.md`
}

function findCaptureConflicts(targetId, title, hits) {
  const normalized = foldTitle(title)
  const target = targetId.normalize('NFC').toLowerCase()
  return hits.filter(hit => {
    if (hit.id.normalize('NFC').toLowerCase() === target) return true
    // A title that folds to nothing carries no identity; matching it would make
    // every untitled note a conflict with every other one.
    return normalized !== '' && foldTitle(hit.title) === normalized
  })
}

function pickProvenance(a) {
  const picked = {}
  if (typeof a.source_session === 'string' && a.source_session !== '') picked.source_session = a.source_session
  if (typeof a.commit === 'string' && a.commit !== '') picked.commit = a.commit
  if (typeof a.verified === 'boolean') picked.verified = a.verified
  return picked
}

async function captureFrontmatter(id, title, tags, now, provenance) {
  let existing
  let version
  try {
    const text = await readFile(await containedPathReal(id), 'utf8')
    existing = splitFrontmatter(text).frontmatter
    version = noteVersion(text)
  } catch (error) {
    // Only a missing note means a first capture; any other failure must not be
    // mistaken for one.
    if (error?.code !== 'ENOENT') throw noteIoError('read', id, error)
  }
  const frontmatter = { ...existing, title, tags, ...provenance }
  const created = existing?.created
  frontmatter.created = typeof created === 'string' && created !== '' ? created : now
  if (version !== undefined) frontmatter.updated = now
  return { frontmatter, existed: version !== undefined, version }
}

/**
 * Port of the curator's `memory_capture`. The MCP server has no approval
 * channel, so a conflict resolves the way the dsh tool resolves it in headless
 * runs: refuse and point at `conflictPolicy: 'skip'` — unless the capture
 * declares `requireExisting: true`, which makes updating an existing note the
 * stated intent and needs no approval. A capture without that flag always
 * writes a full-note replacement — the approve-then-append path stays
 * unreachable — while an update-only capture replaces the note by default.
 * `committed` is absent because MCP writes never run memory-git.
 */
async function captureNote(a = {}) {
  if (typeof a.title !== 'string') throw new Error('memory_capture: title must be a string')
  if (typeof a.summary !== 'string') throw new Error('memory_capture: summary must be a string')
  const targetId = captureTargetId(a.id, a.title)
  const tags = Array.isArray(a.tags) ? a.tags.map(String) : []

  const now = formatBeijingTime(new Date())
  const provenance = pickProvenance(a)
  const [titleSearch, target] = await Promise.all([
    searchNotes(a.title, MAX_SEARCH_RESULTS, a.title), captureFrontmatter(targetId, a.title, tags, now, provenance),
  ])
  const titleHits = titleSearch.hits
  const hits = [...new Map([...(target.existed ? [{ id: targetId, title: a.title }] : []), ...titleHits].map(hit => [hit.id, hit])).values()]
  const conflicts = findCaptureConflicts(targetId, a.title, hits)
  const conflictExists = conflicts.length > 0
  const requireExisting = a.requireExisting === true
  const explicitId = typeof a.id === 'string' && a.id !== ''
  const finalId = requireExisting || explicitId || target.existed ? targetId : conflicts[0]?.id ?? targetId
  if (!requireExisting && !explicitId && !target.existed && (titleHits.length === MAX_SEARCH_RESULTS || conflicts.length > 1)) {
    return { written: false, id: targetId, conflict: true, reason: 'ambiguous or truncated conflict search; provide the exact existing note id before writing' }
  }

  if (conflictExists && !requireExisting) {
    if (a.conflictPolicy === 'skip') {
      return { written: false, id: finalId, conflict: true, reason: 'skipped by conflictPolicy=skip' }
    }
    return {
      written: false,
      id: finalId,
      conflict: true,
      reason: 'approval service or agent unavailable; set conflictPolicy=skip to allow silent skip in headless mode',
    }
  }

  const detailsText = typeof a.details === 'string' && a.details !== '' ? `\n\n## Details\n\n${a.details}` : ''
  const appendContent = `${a.summary}${detailsText}\n`
  // A declared update replaces the old conclusion unless append is explicit.
  // Without one the capture keeps the replace shape MCP always produced, or —
  // when the note is genuinely absent — writeNote refuses it under requireExisting.
  // Overwrites pass the captured version to reject intervening changes.
  const { existed, frontmatter, version } = finalId === targetId
    ? target
    : await captureFrontmatter(finalId, a.title, tags, now, provenance)
  const appending = requireExisting && existed && a.mode === 'append'
  const headingPrefix = a.summary.trimStart().startsWith('#') ? '' : `# ${a.title}\n\n`
  const content = appending
    ? appendContent
    : `---\n${yaml.dump(frontmatter).trim()}\n---\n\n${headingPrefix}${appendContent}`
  const writeMode = appending ? 'append' : 'overwrite'
  const write = await writeNote(finalId, content, writeMode, version ?? noteVersion(''), requireExisting)
  const response = {
    written: true,
    id: write.id,
    mode: writeMode,
    conflict: false,
    version: write.version,
  }
  if (write.created !== undefined) response.created = write.created
  if (write.updated !== undefined) response.updated = write.updated
  return response
}

async function forgetNote(a = {}) {
  if (typeof a.id !== 'string' || !a.id.endsWith('.md')) throw new Error('memory-mcp: memory_forget requires a vault-relative .md note id')
  if (typeof a.baseVersion !== 'string') throw new Error('memory-mcp: memory_forget requires baseVersion')
  const absolutePath = await containedPathReal(a.id)
  const text = await readFile(absolutePath, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`memory-mcp: no such note ${JSON.stringify(a.id)}`)
    throw noteIoError('read', a.id, error)
  })
  if (noteVersion(text) !== a.baseVersion) throw new Error(`note ${a.id} changed since it was read; re-read it before forgetting`)
  const archivedTo = `archive/${a.id}`
  const archivePath = join(VAULT, archivedTo)
  await mkdir(dirname(archivePath), { recursive: true })
  // Resolve containment for the archive target before moving. The destination
  // is inside the vault by construction, but the realpath check still rejects
  // a symlink escape.
  const safeArchivePath = await containedPathReal(archivedTo).catch(() => archivePath)
  if (!safeArchivePath.startsWith(VAULT)) throw new Error('memory-mcp: archive destination outside the vault')
  // Move the note; the source has already passed realpath containment.
  await rename(absolutePath, safeArchivePath)
  return { forgotten: true, id: a.id, archivedTo }
}

async function correctNote(a = {}) {
  if (typeof a.id !== 'string' || !a.id.endsWith('.md')) throw new Error('memory-mcp: correction requires a vault-relative .md note id')
  if (typeof a.baseVersion !== 'string' || typeof a.summary !== 'string') throw new Error('memory-mcp: correction requires baseVersion and complete summary')
  let text
  try {
    text = await readFile(await containedPathReal(a.id), 'utf8')
  } catch (error) {
    if (typeof error?.code === 'string') throw noteIoError('read', a.id, error)
    throw error
  }
  if (noteVersion(text) !== a.baseVersion) throw new Error(`note ${a.id} changed since it was read; re-read it before correcting`)
  const { frontmatter: existing, body } = splitFrontmatter(text)
  const now = formatBeijingTime(new Date())
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]
  const title = typeof existing.title === 'string' && existing.title !== '' ? existing.title : heading ?? a.id.replace(/\.md$/, '')
  const provenance = pickProvenance(a)
  const frontmatter = {
    ...existing,
    title,
    ...(a.tags !== undefined ? { tags: a.tags.map(String) } : {}),
    created: typeof existing.created === 'string' && existing.created !== '' ? existing.created : now,
    updated: now,
    ...provenance,
  }
  const details = a.details ? `\n\n## Details\n\n${a.details}` : ''
  const headingPrefix = a.summary.trimStart().startsWith('#') ? '' : `# ${title}\n\n`
  const content = `---\n${yaml.dump(frontmatter).trim()}\n---\n\n${headingPrefix}${a.summary}${details}\n`
  const written = await writeNote(a.id, content, 'overwrite', a.baseVersion, true)
  return { written: true, id: written.id, mode: 'overwrite', conflict: false, version: written.version, created: written.created, updated: written.updated }
}

async function buildGraph(id, depth = 1, maxNodes = 200) {
  const idOf = p => vaultRelativeId(p)
  const title = async p => {
    const { frontmatter, body } = splitFrontmatter(await readFile(p, 'utf8'))
    const explicitTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : ''
    const headingMatch = /^#\s+(.+)$/m.exec(body)
    return explicitTitle !== ''
      ? explicitTitle
      : (headingMatch?.[1]?.trim() ?? idOf(p).replace(/\.[^.]+$/, ''))
  }
  let paths
  const resolve = await vaultLinkResolver()
  if (id === undefined) {
    paths = await listNotePaths()
  } else {
    const start = await containedPathReal(id)
    const seen = new Map([[idOf(start), start]])
    let frontier = [start]
    for (let level = 0; level < depth && frontier.length > 0; level += 1) {
      const next = []
      for (const p of frontier) {
        for (const link of extractLinks(await readFile(p, 'utf8'))) {
          const t = await resolveLinkTarget(link, resolve)
          if (t !== undefined && !seen.has(idOf(t))) { seen.set(idOf(t), t); next.push(t) }
        }
      }
      frontier = next
    }
    paths = [...seen.values()]
  }
  const truncated = paths.length > maxNodes
  const capped = paths.slice(0, maxNodes)
  const idSet = new Set(capped.map(idOf))
  const nodes = []
  const edges = []
  for (const p of capped) {
    nodes.push({ id: idOf(p), title: await title(p) })
    for (const link of extractLinks(await readFile(p, 'utf8'))) {
      const t = await resolveLinkTarget(link, resolve)
      if (t !== undefined && idSet.has(idOf(t))) edges.push({ from: idOf(p), to: idOf(t) })
    }
  }
  return { nodes, edges, truncated }
}

// ── MCP tool surface ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'wiki_read',
    description: 'Read one Markdown note from the wiki vault, following Obsidian-style [[link]] references up to the configured depth. Returns mtime and modifiedExternally alongside frontmatter, body, links, and version.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Vault-relative path of the note (e.g. "concepts/RAG.md").' } },
      required: ['id'],
    },
  },
  {
    name: 'wiki_search',
    description: 'Search the wiki vault by note title or body keyword. Returns matching note ids and titles.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keyword or phrase to match.' } },
      required: ['query'],
    },
  },
  {
    name: 'wiki_write',
    description: 'Create a new note or append to an existing note. Pass baseVersion from wiki_read to fail loudly when the note changed since the read.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Vault-relative note path ending in .md.' },
        content: { type: 'string', description: 'Markdown content to write or append.' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: 'append (default) or overwrite.' },
        baseVersion: { type: 'string', description: 'Optional version from wiki_read; the write fails if the note changed.' },
        requireExisting: { type: 'boolean', description: 'Refuse to create the note: the write must target an existing note (update-only write).' },
      },
      required: ['id', 'content'],
    },
  },
  {
    name: 'wiki_graph',
    description: 'Return the vault [[link]] graph, or the subgraph reachable from one note within depth hops.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional center note id.' },
        depth: { type: 'integer', description: 'Max link hops from the center (default 1).' },
      },
    },
  },
  {
    name: 'memory_capture',
    description: 'Persist durable knowledge to the vault, mirroring the dsh memory_capture tool: derives the note id from the title when omitted, merges frontmatter on an existing note, and returns the same fields minus committed, which requires memory-git. MCP has no approval channel, so a conflicting capture refuses the write and points at conflictPolicy: "skip" — unless requireExisting declares an update, which replaces the note by default without approval and refuses to create a missing note.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human-readable title; used to derive the note id when id is omitted.' },
        summary: { type: 'string', description: 'The durable knowledge to record, in concise Markdown. For a correction using requireExisting, provide the complete current conclusion.' },
        details: { type: 'string', description: 'Optional additional Markdown context (error traces, alternatives, links).' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: 'Use overwrite to replace an old conclusion; append preserves old text and adds a timestamped section. Update-only captures default to overwrite; pass append explicitly for additive material.' },
        id: { type: 'string', description: 'Optional explicit vault-relative note id; a path without a shared/ prefix lands under the notes dir.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for the note frontmatter.' },
        conflictPolicy: { type: 'string', enum: ['ask', 'skip'], description: 'ask (default) refuses a conflicting capture; skip skips it silently.' },
        requireExisting: { type: 'boolean', description: 'Update-only capture: the note must exist and needs no approval. Defaults to overwrite with a complete replacement summary; pass mode: append for additive material. A missing note fails.' },
        source_session: { type: 'string', description: 'Optional session id that produced this capture, stored in frontmatter for provenance.' },
        commit: { type: 'string', description: 'Optional upstream commit hash or reference this capture relates to, stored in frontmatter for provenance.' },
        verified: { type: 'boolean', description: 'Optional boolean marking the captured knowledge as verified, stored in frontmatter for provenance.' },
      },
      required: ['title', 'summary'],
    },
  },
  {
    name: 'memory_correct',
    description: 'Replace exactly one existing note with a complete current conclusion. First wiki_read the exact id, then pass its version as baseVersion. Missing or changed notes fail; this never appends or selects by title.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Exact vault-relative id from wiki_read.' },
        baseVersion: { type: 'string', description: 'Version from wiki_read; concurrent changes fail.' },
        summary: { type: 'string', description: 'Complete current conclusion in Markdown.' },
        details: { type: 'string', description: 'Optional context included in the new body.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional replacement tags; omitted tags are preserved.' },
        source_session: { type: 'string', description: 'Optional session id that produced this correction, stored in frontmatter for provenance.' },
        commit: { type: 'string', description: 'Optional upstream commit hash or reference this correction relates to, stored in frontmatter for provenance.' },
        verified: { type: 'boolean', description: 'Optional boolean marking the corrected knowledge as verified, stored in frontmatter for provenance.' },
      },
      required: ['id', 'baseVersion', 'summary'],
    },
  },
  {
    name: 'memory_forget',
    description: 'Move a note into the vault archive area (`archive/<original-relative-path>`). The note is not deleted and can still be read directly, but it is excluded from wiki_search and wiki_graph results. Requires the current version from wiki_read as baseVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Exact vault-relative id from wiki_read.' },
        baseVersion: { type: 'string', description: 'Version from wiki_read; concurrent changes fail.' },
      },
      required: ['id', 'baseVersion'],
    },
  },
]

async function callTool(name, a = {}) {
  switch (name) {
    case 'wiki_read': {
      try {
        const absolutePath = await containedPathReal(a.id)
        const note = await readNote(absolutePath, MAX_LINK_DEPTH)
        const info = await stat(absolutePath)
        return {
          ...note,
          mtime: formatBeijingTime(info.mtime),
          modifiedExternally: detectExternalChange(absolutePath, info.mtimeMs),
        }
      } catch (error) {
        // Containment and id errors are already structured and path-free; a
        // raw fs error still carries the absolute path and is rewritten.
        if (typeof error?.code !== 'string') throw error
        throw noteIoError('read', a.id, error)
      }
    }
    case 'wiki_search':
      return searchNotes(a.query ?? '')
    case 'wiki_write':
      return writeNote(a.id, a.content ?? '', a.mode ?? 'append', a.baseVersion, a.requireExisting === true)
    case 'wiki_graph':
      return buildGraph(a.id, a.depth ?? 1)
    case 'memory_capture':
      return captureNote(a)
    case 'memory_correct':
      return correctNote(a)
    case 'memory_forget':
      return forgetNote(a)
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

// ── JSON-RPC stdio loop ─────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const rl = readline.createInterface({ input: process.stdin })
let requests = Promise.resolve()
rl.on('line', line => {
  requests = requests.then(async () => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const { id, method, params } = msg
    if (method === undefined || method.startsWith('notifications/')) return
    try {
      let result
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {} },
            serverInfo: SERVER_INFO,
          }
          break
        case 'ping':
          result = {}
          break
        case 'tools/list':
          result = { tools: TOOLS }
          break
        case 'tools/call': {
          const value = await callTool(params?.name, params?.arguments)
          result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
          break
        }
        case 'resources/list': {
          const paths = await listNotePaths()
          result = {
            resources: paths.map(p => {
              const id = vaultRelativeId(p)
              return {
                uri: `note:///${id}`,
                name: id,
                mimeType: 'text/markdown',
              }
            }),
          }
          break
        }
        case 'resources/read': {
          const uri = params?.uri ?? ''
          const noteId = uri.replace(/^note:\/\/\/?/, '')
          const text = await readFile(await containedPathReal(noteId), 'utf8')
          result = { contents: [{ uri, mimeType: 'text/markdown', text }] }
          break
        }
        default:
          throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
      }
      if (id !== undefined) send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } })
      }
    }
  })
})
