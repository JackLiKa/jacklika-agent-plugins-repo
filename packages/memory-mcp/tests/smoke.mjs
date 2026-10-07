// Smoke test: spawn the server, drive initialize + tools/call over stdio.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const TIMEOUT_MS = 30_000

const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url))

function assert(cond, msg) { if (!cond) throw new Error(`assert: ${msg}`) }

let activeChild = null

async function runSmoke() {
  const vault = await mkdtemp(join(tmpdir(), 'dsh-mcp-vault-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-mcp-outside-'))
  const child = spawn(process.execPath, [server, '--vault', vault], { stdio: ['pipe', 'pipe', 'inherit'] })
  activeChild = child

  const earlyExit = new Promise((_, reject) => {
    child.on('exit', (code, signal) => {
      reject(new Error(`server exited early with code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    })
    child.on('error', reject)
  })

  let buffer = ''
  const pending = new Map()
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl < 0) break
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch (error) {
        console.error('[smoke] invalid JSON from server:', line, error)
      }
    }
  })

  let seq = 0
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, msg => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

  try {
    const init = await Promise.race([call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    }), earlyExit])
    assert(init.serverInfo.name === 'dsh-memory-mcp', 'initialize serverInfo')

    const list = await Promise.race([call('tools/list'), earlyExit])
    assert(list.tools.length === 4, `tools/list count ${list.tools.length}`)

    const w = await Promise.race([call('tools/call', {
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: '# RAG\n\nRetrieval notes link [[Graphs]].' },
    }), earlyExit])
    assert(w.result ?? w, 'wiki_write result')
    const disk = await readFile(join(vault, 'concepts', 'RAG.md'), 'utf8')
    assert(disk.includes('Retrieval notes'), 'note persisted')

    const r = await Promise.race([call('tools/call', { name: 'wiki_read', arguments: { id: 'concepts/RAG.md' } }), earlyExit])
    const note = JSON.parse(r.content[0].text)
    assert(note.version.length === 40, 'wiki_read version')

    await Promise.all([
      Promise.race([call('tools/call', { name: 'wiki_write', arguments: { id: 'concepts/RAG.md', content: 'concurrent-a' } }), earlyExit]),
      Promise.race([call('tools/call', { name: 'wiki_write', arguments: { id: 'concepts/RAG.md', content: 'concurrent-b' } }), earlyExit]),
    ])
    const serialized = await readFile(join(vault, 'concepts', 'RAG.md'), 'utf8')
    assert(serialized.includes('concurrent-a') && serialized.includes('concurrent-b'), 'concurrent writes serialized')

    const conflict = await Promise.race([call('tools/call', {
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: 'x', baseVersion: 'stale' },
    }), earlyExit]).then(() => null, e => e)
    assert(conflict !== null, 'baseVersion conflict must error')

    const s = await Promise.race([call('tools/call', { name: 'wiki_search', arguments: { query: 'Retrieval' } }), earlyExit])
    assert(JSON.parse(s.content[0].text).length === 1, 'wiki_search hit')

    await writeFile(join(outside, 'secret.md'), 'outside\n')
    let linked = false
    try {
      await symlink(outside, join(vault, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      linked = true
    } catch (error) {
      console.warn('[smoke] symlink escape probe skipped:', error.message)
    }
    if (linked) {
      const escaped = await Promise.race([call('tools/call', { name: 'wiki_read', arguments: { id: 'escape/secret.md' } }), earlyExit]).then(() => null, e => e)
      assert(escaped !== null, 'symlink escape must error')
    }

    // wiki_read mtime/modifiedExternally parity with the dsh tool: the first
    // observed read is clean, an external rewrite flags, a wiki_write doesn't.
    const m1 = await Promise.race([call('tools/call', { name: 'wiki_read', arguments: { id: 'concepts/RAG.md' } }), earlyExit])
    const m1Note = JSON.parse(m1.content[0].text)
    assert(typeof m1Note.mtime === 'string' && m1Note.mtime.endsWith('+08:00'), `mtime ${m1Note.mtime}`)
    assert(m1Note.modifiedExternally === false, 'first read must not flag')
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(join(vault, 'concepts', 'RAG.md'), `${await readFile(join(vault, 'concepts', 'RAG.md'), 'utf8')}\nexternal edit\n`)
    const m2 = await Promise.race([call('tools/call', { name: 'wiki_read', arguments: { id: 'concepts/RAG.md' } }), earlyExit])
    assert(JSON.parse(m2.content[0].text).modifiedExternally === true, 'external edit must flag')

    // Overwrite writes normalize frontmatter timestamps to +08:00 seconds.
    await Promise.race([call('tools/call', {
      name: 'wiki_write',
      arguments: {
        id: 'norm/mcp.md',
        mode: 'overwrite',
        content: "---\ncreated: '2026-10-06T08:18:03.391Z'\nupdated: not-a-date\n---\n\n# Norm\n",
      },
    }), earlyExit])
    const normText = await readFile(join(vault, 'norm', 'mcp.md'), 'utf8')
    assert(normText.includes('2026-10-06T16:18:03+08:00'), `normalized created: ${normText}`)
    assert(normText.includes('not-a-date'), 'unparseable value preserved')

    const res = await Promise.race([call('resources/list'), earlyExit])
    assert(res.resources.some(r => r.uri === 'note:///concepts/RAG.md'), 'resources/list')

    const rr = await Promise.race([call('resources/read', { uri: 'note:///concepts/RAG.md' }), earlyExit])
    assert(rr.contents[0].text.includes('Retrieval'), 'resources/read')

    // External editors (e.g. Obsidian on Windows) write CRLF frontmatter with
    // unquoted timestamps; the MCP read path must see the same values as the
    // dsh tools.
    await mkdir(join(vault, 'external'), { recursive: true })
    await writeFile(join(vault, 'external', 'obsidian.md'),
      '---\r\ntitle: External note\r\ncreated: 2026-01-01T00:00:00+08:00\r\ntags:\r\n  - alpha\r\n  - beta\r\n---\r\n\r\nExternal body.\r\n')
    const ext = await Promise.race([call('tools/call', { name: 'wiki_read', arguments: { id: 'external/obsidian.md' } }), earlyExit])
    const extNote = JSON.parse(ext.content[0].text)
    assert(extNote.frontmatter.created === '2026-01-01T00:00:00+08:00', `CRLF frontmatter created ${JSON.stringify(extNote.frontmatter)}`)
    assert(Array.isArray(extNote.frontmatter.tags) && extNote.frontmatter.tags.length === 2, 'CRLF frontmatter tags list')
    assert(extNote.body.includes('External body.'), 'CRLF body parsed')

    // Obsidian-style bare-filename links must resolve across nested dirs:
    // shared/notes/x.md → [[y]] → shared/notes/y.md, visible in both
    // wiki_read's linkedNotes and wiki_graph's edges.
    await mkdir(join(vault, 'shared', 'notes'), { recursive: true })
    await writeFile(join(vault, 'shared', 'notes', 'x.md'), '# X\n\nSee [[y]].\n')
    await writeFile(join(vault, 'shared', 'notes', 'y.md'), '# Y\n\nBody.\n')
    const xr = await Promise.race([call('tools/call', { name: 'wiki_read', arguments: { id: 'shared/notes/x.md' } }), earlyExit])
    const xNote = JSON.parse(xr.content[0].text)
    assert(
      xNote.linkedNotes.some(n => n.id === 'shared/notes/y.md'),
      `bare link [[y]] resolved: ${JSON.stringify(xNote.linkedNotes.map(n => n.id))}`,
    )
    const g = await Promise.race([call('tools/call', { name: 'wiki_graph', arguments: { id: 'shared/notes/x.md' } }), earlyExit])
    const graph = JSON.parse(g.content[0].text)
    assert(
      graph.edges.some(e => e.from === 'shared/notes/x.md' && e.to === 'shared/notes/y.md'),
      `wiki_graph edge x→y: ${JSON.stringify(graph.edges)}`,
    )

    // An unmatched backtick run must not mispair with a later span opener and
    // expose a literal [[link]] — the real-vault defect from the deploy note.
    await writeFile(join(vault, 'shared', 'notes', 'z.md'),
      '# Z\n\nFences `(``` / ~~~)` are literal, and `[[link]]` documents syntax.\nSee [[x]] and [[y]].\n')
    const zr = await Promise.race([call('tools/call', { name: 'wiki_read', arguments: { id: 'shared/notes/z.md' } }), earlyExit])
    const zNote = JSON.parse(zr.content[0].text)
    assert(!zNote.links.includes('link'), `literal [[link]] leaked: ${JSON.stringify(zNote.links)}`)
    assert(zNote.links.includes('x') && zNote.links.includes('y'), `real links kept: ${JSON.stringify(zNote.links)}`)

    console.log('memory-mcp smoke: all assertions passed')
    if (!linked) {
      console.warn('memory-mcp smoke: symlink escape probe was skipped on this platform')
    }
  } finally {
    if (activeChild?.exitCode === null && activeChild?.killed === false) {
      activeChild.kill()
    }
    activeChild = null
    await rm(vault, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }

  return null
}

const timeout = new Promise((_, reject) => {
  const t = setTimeout(() => {
    if (activeChild?.exitCode === null && activeChild?.killed === false) {
      activeChild.kill()
    }
    reject(new Error(`smoke timed out after ${TIMEOUT_MS}ms`))
  }, TIMEOUT_MS)
  // Unref so a successful run is not kept alive solely by this timer.
  if (typeof t.unref === 'function') t.unref()
})

Promise.race([runSmoke(), timeout]).then(
  () => { process.exitCode = 0 },
  (error) => {
    console.error('memory-mcp smoke failed:', error)
    process.exitCode = 1
  },
)
