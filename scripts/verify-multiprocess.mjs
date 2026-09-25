import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const worker = join(root, 'scripts', 'queue-worker.mjs')
const vault = await mkdtemp(join(tmpdir(), 'mydsh-multiprocess-'))

function start(mode, marker) {
  return spawn(process.execPath, [worker, mode, vault, marker], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function exited(child) {
  return new Promise((resolveExit, reject) => {
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal, stderr }))
  })
}

async function waitForPath(path) {
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      await stat(path)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
}

try {
  const first = start('write', 'writer-a')
  const second = start('write', 'writer-b')
  const [firstExit, secondExit] = await Promise.all([exited(first), exited(second)])
  for (const outcome of [firstExit, secondExit]) {
    if (outcome.code !== 0) throw new Error(`writer failed (${outcome.signal ?? outcome.code}): ${outcome.stderr}`)
  }
  const note = await readFile(join(vault, 'shared', 'concurrent.md'), 'utf8')
  if (!note.includes('writer-a') || !note.includes('writer-b')) throw new Error('same-note writes were lost')

  const holder = start('hold', 'crash')
  const holderExit = exited(holder)
  const lane = createHash('sha1').update('shared/concurrent.md').digest('hex')
  await waitForPath(join(vault, '.memory-queue.lock.lanes', `${lane}.lock`))
  holder.kill()
  await holderExit
  const recovery = start('write', 'after-crash')
  const recoveryExit = await exited(recovery)
  if (recoveryExit.code !== 0) throw new Error(`stale-lock recovery failed: ${recoveryExit.stderr}`)
  process.stdout.write('multi-process same-note serialization and stale-lock recovery verified\n')
} finally {
  await rm(vault, { recursive: true, force: true })
}
