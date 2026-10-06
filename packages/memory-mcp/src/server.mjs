#!/usr/bin/env node
/**
 * @jacklika/dsh-memory-mcp — an MCP stdio server exposing the memory vault to
 * any MCP client. One process owns all writes, so clients serialize through
 * the server instead of negotiating filesystem locks.
 *
 * Usage: dsh-memory-mcp [--vault <path>] [--max-link-depth N]
 *   --vault defaults to <cwd>/.plugins/memory/ to match the Bundle default.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
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
const EXTENSIONS = ['.md']
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.obsidian'])

/** Return a POSIX-style vault-relative id from an absolute path. */
function vaultRelativeId(absolutePath) {
  return relative(VAULT, absolutePath).replace(/\\/g, '/')
}

// ── Vault operations (mirrors @jacklika/dsh-tool-memory-filesystem) ──────────

function containedPath(candidate) {
  const absolute = resolve(VAULT, candidate)
  const remainder = relative(VAULT, absolute)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`path ${candidate} is outside vault root ${VAULT}`)
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
        throw new Error(`path ${candidate} resolves outside vault root ${VAULT}`)
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
  if (resolve !== undefined) {
    const id = resolve(link)
    if (id !== undefined) return containedPathReal(id)
  }
  for (const candidate of [link, ...EXTENSIONS.map(ext => `${link}${ext}`)]) {
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
  return { id, frontmatter, body, links, version: noteVersion(text), linkedNotes }
}

async function searchNotes(query, maxResults = 20) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const notes = []
  for (const path of await listNotePaths()) {
    const text = await readFile(path, 'utf8')
    const { body } = splitFrontmatter(text)
    const id = vaultRelativeId(path)
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? id.replace(/\.[^.]+$/, '')
    notes.push({ id, title, links: extractLinks(text), body })
  }
  const hits = notes.filter(n => {
    const haystack = `${n.id} ${n.title} ${n.body}`.toLowerCase()
    return terms.every(t => haystack.includes(t))
  })
  hits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return hits.slice(0, maxResults).map(({ id, title }) => ({ id, title }))
}

async function writeNote(id, content, mode = 'append', baseVersion) {
  if (!EXTENSIONS.some(ext => id.endsWith(ext))) {
    throw new Error(`note id must end with one of ${EXTENSIONS.join(', ')}`)
  }
  await mkdir(VAULT, { recursive: true })
  const absolutePath = await containedPathReal(id)
  await mkdir(dirname(absolutePath), { recursive: true })
  await containedPathReal(id)
  let existing
  try {
    existing = await readFile(absolutePath, 'utf8')
  } catch { /* new note */ }
  if (baseVersion !== undefined && noteVersion(existing ?? '') !== baseVersion) {
    throw new Error(`note ${id} changed since it was read; re-read it before writing`)
  }
  let finalBody
  if (mode === 'overwrite') {
    finalBody = content
  } else {
    const { frontmatter, body } = splitFrontmatter(existing ?? '')
    const fm = Object.keys(frontmatter).length > 0
      ? `---\n${yaml.dump(frontmatter).trimEnd()}\n---\n\n`
      : ''
    finalBody = `${fm}${body}\n\n## ${formatBeijingTime(new Date())}\n\n${content}\n`
  }
  const tmp = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(tmp, finalBody, 'utf8')
    await rename(tmp, absolutePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  return { id: vaultRelativeId(absolutePath), mode, bytes: Buffer.byteLength(finalBody, 'utf8') }
}

async function buildGraph(id, depth = 1, maxNodes = 200) {
  const idOf = p => vaultRelativeId(p)
  const title = async p => {
    const { body } = splitFrontmatter(await readFile(p, 'utf8'))
    return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? idOf(p).replace(/\.[^.]+$/, '')
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
    description: 'Read one Markdown note from the wiki vault, following Obsidian-style [[link]] references up to the configured depth.',
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
]

async function callTool(name, a = {}) {
  switch (name) {
    case 'wiki_read':
      return readNote(await containedPathReal(a.id), MAX_LINK_DEPTH)
    case 'wiki_search':
      return searchNotes(a.query ?? '')
    case 'wiki_write':
      return writeNote(a.id, a.content ?? '', a.mode ?? 'append', a.baseVersion)
    case 'wiki_graph':
      return buildGraph(a.id, a.depth ?? 1)
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
