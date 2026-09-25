#!/usr/bin/env node
/**
 * @jacklika/dsh-memory-mcp — a zero-dependency MCP stdio server exposing the
 * memory vault to any MCP client. One process owns all writes, so clients
 * serialize through the server instead of negotiating filesystem locks.
 *
 * Usage: dsh-memory-mcp [--vault <path>] [--max-link-depth N]
 *   --vault defaults to <cwd>/.dsh/memory/
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'dsh-memory-mcp', version: '0.1.0' }

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function argValue(flag, fallback) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const VAULT = resolve(argValue('--vault', join(process.cwd(), '.dsh', 'memory')))
const MAX_LINK_DEPTH = Number(argValue('--max-link-depth', '1'))
const EXTENSIONS = ['.md']
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.obsidian'])

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

function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { frontmatter: {}, body: text }
  const frontmatter = {}
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (m) frontmatter[m[1]] = m[2]
  }
  return { frontmatter, body: text.slice(end + 5) }
}

function noteVersion(text) {
  return createHash('sha1').update(text).digest('hex')
}

function extractLinks(text) {
  const links = []
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) links.push(m[1].trim())
  return links
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

async function resolveLinkTarget(link) {
  for (const candidate of [link, ...EXTENSIONS.map(ext => `${link}${ext}`)]) {
    try {
      const p = await containedPathReal(candidate)
      await readFile(p, 'utf8')
      return p
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  // search by basename among indexed notes
  const want = basename(link).replace(/\.[^.]+$/, '')
  for (const p of await listNotePaths()) {
    if (basename(p).replace(/\.[^.]+$/, '') === want) return p
  }
  return undefined
}

async function readNote(absolutePath, depth, visited = new Set()) {
  const id = relative(VAULT, absolutePath)
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
    for (const link of links) {
      const target = await resolveLinkTarget(link)
      if (target !== undefined) linkedNotes.push(await readNote(target, depth - 1, next))
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
    const id = relative(VAULT, path)
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? id.replace(/\.[^.]+$/, '')
    notes.push({ id, title, links: extractLinks(text), body })
  }
  const hits = notes.filter(n => {
    const haystack = `${n.id} ${n.title} ${n.body}`.toLowerCase()
    return terms.every(t => haystack.includes(t))
  })
  hits.sort((a, b) => a.id.localeCompare(b.id))
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
      ? `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n`
      : ''
    finalBody = `${fm}${body}\n\n## ${new Date().toISOString()}\n\n${content}\n`
  }
  const tmp = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(tmp, finalBody, 'utf8')
    await rename(tmp, absolutePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  return { id: relative(VAULT, absolutePath), mode, bytes: Buffer.byteLength(finalBody, 'utf8') }
}

async function buildGraph(id, depth = 1, maxNodes = 200) {
  const idOf = p => relative(VAULT, p)
  const title = async p => {
    const { body } = splitFrontmatter(await readFile(p, 'utf8'))
    return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? idOf(p).replace(/\.[^.]+$/, '')
  }
  let paths
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
          const t = await resolveLinkTarget(link)
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
      const t = await resolveLinkTarget(link)
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
            resources: paths.map(p => ({
              uri: `note:///${relative(VAULT, p)}`,
              name: relative(VAULT, p),
              mimeType: 'text/markdown',
            })),
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
