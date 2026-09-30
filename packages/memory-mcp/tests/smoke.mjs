// Smoke test: spawn the server, drive initialize + tools/call over stdio.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

    const res = await Promise.race([call('resources/list'), earlyExit])
    assert(res.resources.length === 1 && res.resources[0].uri === 'note:///concepts/RAG.md', 'resources/list')

    const rr = await Promise.race([call('resources/read', { uri: 'note:///concepts/RAG.md' }), earlyExit])
    assert(rr.contents[0].text.includes('Retrieval'), 'resources/read')

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
