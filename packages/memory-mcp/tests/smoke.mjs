// Smoke test: spawn the server, drive initialize + tools/call over stdio.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
    pending.set(id, msg => {
      try {
        if (msg.error) {
          reject(new Error(msg.error.message))
        } else {
          resolve(msg.result)
        }
      } catch (e) {
        console.error('[smoke] pending callback error for', method, e)
        reject(e)
      }
    })
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
    assert(list.tools.length === 7 && list.tools.some(tool => tool.name === 'memory_correct') && list.tools.some(tool => tool.name === 'memory_forget'), `tools/list correction/forget tools ${list.tools.length}`)

    const lockedId = 'concepts/coordination.md'
    const lockKey = createHash('sha1').update(lockedId).digest('hex')
    const lockDir = join(vault, '.memory-queue.lock.lanes', `${lockKey}.lock`)
    await mkdir(lockDir, { recursive: true })
    const waitingWrite = call('tools/call', { name: 'wiki_write', arguments: { id: lockedId, content: '# Coordinated' } })
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      assert(!(await readFile(join(vault, lockedId), 'utf8').then(() => true, () => false)), 'MCP respects the shared DSH write lock')
    } finally {
      await rm(lockDir, { recursive: true, force: true })
    }
    await Promise.race([waitingWrite, earlyExit])
    assert((await readFile(join(vault, lockedId), 'utf8')).includes('Coordinated'), 'MCP writes after lock release')

    const w = await Promise.race([call('tools/call', {
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: '# RAG\n\nRetrieval notes link [[Graphs]].' },
    }), earlyExit])
    const writeBlocks = w.content ?? (w.result ? w.result.content : undefined)
    assert(Array.isArray(writeBlocks) && writeBlocks.length > 0, 'wiki_write response blocks')
    const writeResult = JSON.parse(writeBlocks[0].text)
    assert(writeResult.version.length === 40, 'wiki_write version')
    assert(typeof writeResult.created === 'string' && writeResult.created.endsWith('+08:00'), `wiki_write created: ${writeResult.created}`)
    assert(!('updated' in writeResult), 'first write has no updated')
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

    // Sequential append returns updated and preserves created from the first write.
    const append = await Promise.race([call('tools/call', { name: 'wiki_write', arguments: { id: 'concepts/RAG.md', content: 'append-section' } }), earlyExit])
    const appendBlocks = append.content ?? (append.result ? append.result.content : undefined)
    assert(Array.isArray(appendBlocks) && appendBlocks.length > 0, 'append response blocks')
    const appendResult = JSON.parse(appendBlocks[0].text)
    assert(appendResult.created === writeResult.created, 'append preserves created')
    assert(typeof appendResult.updated === 'string' && appendResult.updated.endsWith('+08:00'), `append updated: ${appendResult.updated}`)
    assert(appendResult.version !== writeResult.version, 'append changes version')

    const conflict = await Promise.race([call('tools/call', {
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: 'x', baseVersion: 'stale' },
    }), earlyExit]).then(() => null, e => e)
    assert(conflict !== null, 'baseVersion conflict must error')

    const s = await Promise.race([call('tools/call', { name: 'wiki_search', arguments: { query: 'Retrieval' } }), earlyExit])
    const searchResult = JSON.parse(s.content[0].text)
    assert(searchResult.hits.length === 1 && searchResult.total === 1 && searchResult.fused === false && searchResult.semantic === 'unavailable', 'wiki_search hit')

    // Frontmatter `title` must win over body heading in search results.
    await Promise.race([call('tools/call', {
      name: 'wiki_write',
      arguments: {
        id: 'explicit/title.md',
        mode: 'overwrite',
        content: "---\ntitle: Explicit Smoke Title\ncreated: 2026-10-12T00:00:00+08:00\n---\n\n# Body Heading\n\nsearch target text\n",
      },
    }), earlyExit])
    const titleSearch = await Promise.race([call('tools/call', { name: 'wiki_search', arguments: { query: 'target' } }), earlyExit])
    const titleHits = JSON.parse(titleSearch.content[0].text)
    assert(titleHits.hits.length === 1, 'frontmatter title search hit')
    assert(titleHits.hits[0].title === 'Explicit Smoke Title', `frontmatter title wins: ${titleHits.hits[0].title}`)

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

    // memory_capture parity with the dsh curator tool: derived id under the
    // notes dir, merged frontmatter, and the
    // {written,id,mode,conflict,version,created?} response. `committed` is
    // absent because MCP runs no memory-git.
    const cap = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'MCP Parity: Capture!', summary: 'capture smoke summary', tags: ['smoke'] },
    }), earlyExit])
    const capResult = JSON.parse(cap.content[0].text)
    assert(capResult.written === true && capResult.conflict === false, `capture result ${JSON.stringify(capResult)}`)
    assert(capResult.id === 'shared/notes/mcp-parity-capture.md', `derived capture id ${capResult.id}`)
    assert(capResult.mode === 'overwrite', 'a capture that writes is a full-note overwrite')
    assert(typeof capResult.version === 'string' && capResult.version.length === 40, 'capture version')
    assert(typeof capResult.created === 'string' && capResult.created.endsWith('+08:00'), `capture created ${capResult.created}`)
    assert(!('updated' in capResult), 'first capture has no updated')
    assert(!('committed' in capResult), 'MCP never reports committed')
    const capText = await readFile(join(vault, 'shared', 'notes', 'mcp-parity-capture.md'), 'utf8')
    assert(/title:.*MCP Parity: Capture!/.test(capText), `capture frontmatter title: ${capText}`)
    assert(capText.includes('# MCP Parity: Capture!'), 'capture heading')
    assert(capText.includes('- smoke'), 'capture tags')
    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(vault, 'shared', 'notes', `noise-${index}.md`), `# Noise ${index}\n\nDSH rc25 private unique shared common terms.\n`)
    }
    const broadPrivate = await Promise.race([call('tools/call', {
      name: 'wiki_search', arguments: { query: 'DSH rc25 private unique' },
    }), earlyExit])
    assert(JSON.parse(broadPrivate.content[0].text).hits.length === 20, 'broad MCP keyword search is capped')
    const newPrivateTitle = await Promise.race([call('tools/call', {
      name: 'memory_capture', arguments: { title: 'DSH rc25 private unique', summary: 'New curated knowledge.' },
    }), earlyExit])
    assert(JSON.parse(newPrivateTitle.content[0].text).written === true, 'capped unrelated MCP search does not prevent first capture')

    // An explicit id without a shared/ prefix lands under the notes dir, the
    // same rewrite the curator's shared scope performs.
    const capExplicit = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'Explicit Capture Id', summary: 'explicit id summary', id: 'concepts/custom' },
    }), earlyExit])
    assert(JSON.parse(capExplicit.content[0].text).id === 'shared/notes/concepts/custom.md', 'explicit id scoped under notes dir')

    // No approval channel exists over MCP, so a conflict resolves the way the
    // dsh tool resolves it headless: refuse and point at conflictPolicy=skip.
    const recapture = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'MCP Parity: Capture!', summary: 'second' },
    }), earlyExit])
    const recaptureResult = JSON.parse(recapture.content[0].text)
    assert(recaptureResult.written === false && recaptureResult.conflict === true, `conflict refuses ${JSON.stringify(recaptureResult)}`)
    assert(recaptureResult.reason.includes('conflictPolicy=skip'), `conflict reason ${recaptureResult.reason}`)
    const skipped = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'MCP Parity: Capture!', summary: 'third', conflictPolicy: 'skip' },
    }), earlyExit])
    const skippedResult = JSON.parse(skipped.content[0].text)
    assert(skippedResult.reason === 'skipped by conflictPolicy=skip', 'skip reason')
    // Conflict refusal carries the same correction hint the dsh curator
    // returns: the collided note id, and its version when already read.
    assert(skippedResult.suggested?.tool === 'memory_correct', `suggested tool ${JSON.stringify(skippedResult.suggested)}`)
    assert(skippedResult.suggested?.id === 'shared/notes/mcp-parity-capture.md', `suggested id ${skippedResult.suggested?.id}`)

    // A summary that carries its own heading must not gain a duplicate H1 —
    // the same predicate the dsh curator applies.
    const h1Cap = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'MCP Heading Title', summary: '# Caller Heading\n\nBody under a caller-supplied heading.' },
    }), earlyExit])
    const h1CapResult = JSON.parse(h1Cap.content[0].text)
    assert(h1CapResult.written === true, `h1 capture ${JSON.stringify(h1CapResult)}`)
    const h1Text = await readFile(join(vault, h1CapResult.id), 'utf8')
    assert((h1Text.match(/^#\s/gm) ?? []).length === 1, `capture produced ${(h1Text.match(/^#\s/gm) ?? []).length} H1s`)
    assert(h1Text.includes('# Caller Heading') && !h1Text.includes('# MCP Heading Title'), 'caller heading wins')
    const h1Correct = await Promise.race([call('tools/call', {
      name: 'memory_correct',
      arguments: { id: h1CapResult.id, baseVersion: h1CapResult.version, summary: '# Replacement Heading\n\nNew body.' },
    }), earlyExit])
    assert(JSON.parse(h1Correct.content[0].text).written === true, 'h1 correct written')
    const h1CorrectText = await readFile(join(vault, h1CapResult.id), 'utf8')
    assert((h1CorrectText.match(/^#\s/gm) ?? []).length === 1, 'correction keeps one H1')
    assert(h1CorrectText.includes('# Replacement Heading'), 'correction heading kept')

    const badCaptureId = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'Unsafe', summary: 's', id: '../escape' },
    }), earlyExit]).then(() => null, e => e)
    assert(badCaptureId !== null, 'unsafe capture id must error')
    await writeFile(join(vault, 'shared', 'notes', 'ambiguous-one.md'), '---\ntitle: Ambiguous decision\n---\n\nFirst.\n')
    await writeFile(join(vault, 'shared', 'notes', 'ambiguous-two.md'), '---\ntitle: Ambiguous decision\n---\n\nSecond.\n')
    const ambiguous = await Promise.race([call('tools/call', {
      name: 'memory_capture', arguments: { title: 'Ambiguous decision', summary: 'Must not choose.', conflictPolicy: 'skip' },
    }), earlyExit])
    const ambiguousResult = JSON.parse(ambiguous.content[0].text)
    assert(ambiguousResult.written === false && ambiguousResult.reason.includes('ambiguous'), 'ambiguous MCP title fails closed')

    // Update-only writes: a declared update replaces the old conclusion and
    // needs no approval, while one aimed at a missing note refuses instead of
    // creating it.
    const update = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'MCP Parity: Capture!', summary: 'declared update', requireExisting: true },
    }), earlyExit])
    const updateResult = JSON.parse(update.content[0].text)
    assert(
      updateResult.written === true && updateResult.conflict === false && updateResult.mode === 'overwrite',
      `update-only capture ${JSON.stringify(updateResult)}`,
    )
    const updatedText = await readFile(join(vault, 'shared', 'notes', 'mcp-parity-capture.md'), 'utf8')
    assert(!updatedText.includes('capture smoke summary') && updatedText.includes('declared update'), 'update-only capture replaces the old conclusion')
    assert((updatedText.match(/# MCP Parity: Capture!/g) ?? []).length === 1, 'update-only capture keeps one heading')

    const appended = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'MCP Parity: Capture!', summary: 'additional context', requireExisting: true, mode: 'append' },
    }), earlyExit])
    assert(JSON.parse(appended.content[0].text).mode === 'append', 'explicit append retains its mode')
    const appendedText = await readFile(join(vault, 'shared', 'notes', 'mcp-parity-capture.md'), 'utf8')
    assert(appendedText.includes('declared update') && appendedText.includes('additional context'), 'explicit append retains both sections')

    const current = await Promise.race([call('tools/call', {
      name: 'wiki_read', arguments: { id: capResult.id },
    }), earlyExit])
    const currentVersion = JSON.parse(current.content[0].text).version
    const corrected = await Promise.race([call('tools/call', {
      name: 'memory_correct', arguments: { id: capResult.id, baseVersion: currentVersion, summary: 'One current conclusion.' },
    }), earlyExit])
    const correctedResult = JSON.parse(corrected.content[0].text)
    assert(correctedResult.written === true && correctedResult.mode === 'overwrite', 'MCP explicit correction succeeds')
    const correctedText = await readFile(join(vault, 'shared', 'notes', 'mcp-parity-capture.md'), 'utf8')
    assert(correctedText.includes('One current conclusion.') && !correctedText.includes('declared update'), 'MCP corrected body is current only')
    const staleCorrection = await Promise.race([call('tools/call', {
      name: 'memory_correct', arguments: { id: capResult.id, baseVersion: currentVersion, summary: 'Stale conclusion.' },
    }), earlyExit]).then(() => null, e => e)
    assert(staleCorrection !== null && String(staleCorrection.message).includes('changed since it was read'), 'stale MCP correction fails closed')
    assert(!(await readFile(join(vault, 'shared', 'notes', 'mcp-parity-capture.md'), 'utf8')).includes('Stale conclusion.'), 'stale correction leaves note unchanged')

    const updateMissing = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'Update Missing Smoke', summary: 's', requireExisting: true },
    }), earlyExit]).then(() => null, e => e)
    // memory_forget: archive a note and confirm it drops out of search.
    const forgetTarget = await Promise.race([call('tools/call', {
      name: 'wiki_write',
      arguments: { id: 'shared/notes/mcp-forget-target.md', content: '# MCP Forget Target\n\nforgettable content', mode: 'overwrite' },
    }), earlyExit])
    const forgetTargetVersion = JSON.parse(forgetTarget.content[0].text).version
    const beforeForget = await Promise.race([call('tools/call', { name: 'wiki_search', arguments: { query: 'forgettable' } }), earlyExit])
    assert(JSON.parse(beforeForget.content[0].text).hits.length === 1, 'search finds forgettable note')
    const forgotten = await Promise.race([call('tools/call', {
      name: 'memory_forget', arguments: { id: 'shared/notes/mcp-forget-target.md', baseVersion: forgetTargetVersion },
    }), earlyExit])
    const forgetResult = JSON.parse(forgotten.content[0].text)
    assert(forgetResult.forgotten === true && forgetResult.archivedTo === 'archive/shared/notes/mcp-forget-target.md', 'MCP forget succeeds')
    assert((await readFile(join(vault, 'archive', 'shared', 'notes', 'mcp-forget-target.md'), 'utf8')).includes('forgettable'), 'note moved to archive')
    const afterForget = await Promise.race([call('tools/call', { name: 'wiki_search', arguments: { query: 'forgettable' } }), earlyExit])
    assert(JSON.parse(afterForget.content[0].text).hits.length === 0, 'search no longer returns archived note')
    const staleForget = await Promise.race([call('tools/call', {
      name: 'memory_forget', arguments: { id: 'shared/notes/mcp-forget-target.md', baseVersion: forgetTargetVersion },
    }), earlyExit]).then(() => null, e => e)
    assert(staleForget !== null && String(staleForget.message).includes('no such note'), 'forget on archived source fails closed')

    assert(updateMissing !== null, 'update-only capture of a missing note must error')
    const mismatchedId = await Promise.race([call('tools/call', {
      name: 'memory_capture',
      arguments: { title: 'MCP Parity: Capture!', id: 'missing-target.md', summary: 'do not redirect', requireExisting: true },
    }), earlyExit]).then(() => null, e => e)
    assert(mismatchedId !== null && String(mismatchedId.message).includes('does not exist'), 'explicit update-only id must not redirect to a title match')
    assert(!(await readFile(join(vault, 'shared', 'notes', 'mcp-parity-capture.md'), 'utf8')).includes('do not redirect'), 'title match remains unchanged')

    const writeMissing = await Promise.race([call('tools/call', {
      name: 'wiki_write',
      arguments: { id: 'concepts/missing-update.md', content: 'x', requireExisting: true },
    }), earlyExit]).then(() => null, e => e)
    assert(writeMissing !== null, 'update-only write to a missing note must error')
    assert(String(writeMissing.message).includes('does not exist'), `missing-note reason ${writeMissing.message}`)
    assert(!String(writeMissing.message).includes(vault), `missing-note error must not leak the vault path: ${writeMissing.message}`)

    // Backslash ids are rejected the way the dsh tools reject them, and the
    // message stays path-free.
    const backslash = await Promise.race([call('tools/call', {
      name: 'wiki_read',
      arguments: { id: 'concepts\\RAG.md' },
    }), earlyExit]).then(() => null, e => e)
    assert(backslash !== null, 'backslash id must error')
    assert(String(backslash.message).includes('must not contain a backslash'), `backslash reason ${backslash.message}`)
    assert(!String(backslash.message).includes(vault), `backslash error must not leak the vault path: ${backslash.message}`)

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
