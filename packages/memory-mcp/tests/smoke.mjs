// Smoke test: spawn the server, drive initialize + tools/call over stdio.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url))
const vault = await mkdtemp(join(tmpdir(), 'dsh-mcp-vault-'))
const outside = await mkdtemp(join(tmpdir(), 'dsh-mcp-outside-'))

const child = spawn('node', [server, '--vault', vault], { stdio: ['pipe', 'pipe', 'inherit'] })
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
    const msg = JSON.parse(line)
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})

let seq = 0
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, msg => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})

const assert = (cond, msg) => { if (!cond) throw new Error(`assert: ${msg}`) }

try {
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  })
  assert(init.serverInfo.name === 'dsh-memory-mcp', 'initialize serverInfo')

  const list = await call('tools/list')
  assert(list.tools.length === 4, `tools/list count ${list.tools.length}`)

  const w = await call('tools/call', {
    name: 'wiki_write',
    arguments: { id: 'concepts/RAG.md', content: '# RAG\n\nRetrieval notes link [[Graphs]].' },
  })
  assert(w.result ?? w, 'wiki_write result')
  const disk = await readFile(join(vault, 'concepts', 'RAG.md'), 'utf8')
  assert(disk.includes('Retrieval notes'), 'note persisted')

  const r = await call('tools/call', { name: 'wiki_read', arguments: { id: 'concepts/RAG.md' } })
  const note = JSON.parse(r.content[0].text)
  assert(note.version.length === 40, 'wiki_read version')

  await Promise.all([
    call('tools/call', { name: 'wiki_write', arguments: { id: 'concepts/RAG.md', content: 'concurrent-a' } }),
    call('tools/call', { name: 'wiki_write', arguments: { id: 'concepts/RAG.md', content: 'concurrent-b' } }),
  ])
  const serialized = await readFile(join(vault, 'concepts', 'RAG.md'), 'utf8')
  assert(serialized.includes('concurrent-a') && serialized.includes('concurrent-b'), 'concurrent writes serialized')

  const conflict = await call('tools/call', {
    name: 'wiki_write',
    arguments: { id: 'concepts/RAG.md', content: 'x', baseVersion: 'stale' },
  }).then(() => null, e => e)
  assert(conflict !== null, 'baseVersion conflict must error')

  const s = await call('tools/call', { name: 'wiki_search', arguments: { query: 'Retrieval' } })
  assert(JSON.parse(s.content[0].text).length === 1, 'wiki_search hit')

  await writeFile(join(outside, 'secret.md'), 'outside\n')
  await symlink(outside, join(vault, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const escaped = await call('tools/call', { name: 'wiki_read', arguments: { id: 'escape/secret.md' } }).then(() => null, e => e)
  assert(escaped !== null, 'symlink escape must error')

  const res = await call('resources/list')
  assert(res.resources.length === 1 && res.resources[0].uri === 'note:///concepts/RAG.md', 'resources/list')

  const rr = await call('resources/read', { uri: 'note:///concepts/RAG.md' })
  assert(rr.contents[0].text.includes('Retrieval'), 'resources/read')

  console.log('memory-mcp smoke: all assertions passed')
} finally {
  child.kill()
  await rm(vault, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
