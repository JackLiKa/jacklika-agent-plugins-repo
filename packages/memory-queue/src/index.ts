/**
 * Serializes selected model-facing tool calls through the `tools/execute`
 * waterfall. Mounting this plugin next to `@jacklika/dsh-tool-memory-filesystem`
 * prevents overlapping `wiki_write` executions from racing the same vault
 * without changing the memory tools themselves. With `crossProcessLock`
 * enabled, each serialized dispatch additionally acquires an `mkdir`-based
 * lock directory inside the vault root, so separate dsh processes cannot
 * interleave writes.
 * @module @jacklika/dsh-memory-queue
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { resolveMemoryVaultRoot } from '@jacklika/dsh-tool-memory-filesystem'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-queue'

/** Services required so the listener registers after the tool registry exists. */
export const inject = ['tools']

/** Lock directory name placed inside the vault root. */
const LOCK_DIR = '.memory-queue.lock'

/** Plugin configuration. */
export interface Config {
  /** Tool names whose dispatches run one-at-a-time in registration order. */
  toolNames?: string[]
  /**
   * Vault root that hosts the lock directory. Resolved per call with the same
   * rules as the memory tools: empty selects `<session cwd>/.dsh/memory/`, a
   * relative path anchors at the session workspace.
   */
  vaultRoot?: string
  /**
   * Acquire a lock directory in the vault root around each serialized
   * dispatch so separate processes cannot interleave matching tool calls.
   */
  crossProcessLock?: boolean
  /**
   * Name of a string tool argument whose value scopes a private serialization
   * lane and lock directory (for example `id` on `wiki_write` so writes to
   * different notes run in parallel). Empty string keeps one global lane.
   */
  laneArgument?: string
  /** A lock directory unrefreshed for this long counts as abandoned and is reclaimed. */
  lockStaleMs?: number
  /** Interval at which the holder refreshes the lock directory mtime. */
  lockHeartbeatMs?: number
  /** Give up waiting for a held lock after this many milliseconds. */
  lockTimeoutMs?: number
  /** Delay between lock acquisition attempts. */
  lockRetryMs?: number
}

/** Schemastery configuration for the memory queue consumer. */
export const Config: z<Config> = z.object({
  toolNames: z.array(z.string()).default(['wiki_write']),
  vaultRoot: z.string().default(''),
  crossProcessLock: z.boolean().default(false),
  laneArgument: z.string().default(''),
  lockStaleMs: z.number().default(15000),
  lockHeartbeatMs: z.number().default(2000),
  lockTimeoutMs: z.number().default(30000),
  lockRetryMs: z.number().default(100),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`memory-queue: ${field} must be a positive integer`)
  }
}

function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    void work.then(
      value => { signal.removeEventListener('abort', aborted); resolve(value) },
      error => { signal.removeEventListener('abort', aborted); reject(error) },
    )
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  return waitFor(new Promise<void>(resolve => { timer = setTimeout(resolve, ms) }), signal).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

interface LockOwner {
  token: string
  hostname: string
  pid: number
  startedAt: string
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockOwner>
    if (typeof value.token !== 'string' || typeof value.hostname !== 'string' || typeof value.pid !== 'number') return undefined
    return { token: value.token, hostname: value.hostname, pid: value.pid, startedAt: String(value.startedAt ?? '') }
  } catch {
    return undefined
  }
}

function processIsAlive(owner: LockOwner | undefined): boolean {
  if (owner === undefined || owner.hostname !== hostname()) return false
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Acquire the vault's lock directory, waiting for foreign holders and
 * reclaiming locks whose heartbeat stopped. The holder writes an incrementing
 * counter to `<lock>/heartbeat` every `lockHeartbeatMs`; a waiter declares a
 * lock stale only when the observed liveness token fails to change across
 * `lockStaleMs` of its own local clock, so cross-machine clock skew and mtime
 * coherence never affect liveness. Locks without a heartbeat file (foreign
 * writers, older versions) are observed through directory mtime changes under
 * the same local-clock rule.
 * @param lockPath - absolute path of the lock directory.
 * @param resolved - applied plugin configuration.
 * @param signal - caller signal; an aborted caller fails instead of waiting.
 * @returns release callback that stops the heartbeat and removes the lock directory.
 */
async function acquireLock(
  lockPath: string,
  resolved: ResolvedConfig,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const heartbeatPath = join(lockPath, 'heartbeat')
  const ownerPath = join(lockPath, 'owner.json')
  const deadline = Date.now() + resolved.lockTimeoutMs
  let lastObserved: string | undefined
  let lastChangeAt = Date.now()
  for (;;) {
    signal.throwIfAborted()
    try {
      await mkdir(lockPath)
      const owner: LockOwner = {
        token: randomUUID(),
        hostname: hostname(),
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }
      await writeFile(ownerPath, JSON.stringify(owner), 'utf8')
      let counter = 0
      await writeFile(heartbeatPath, String(counter), 'utf8').catch(() => undefined)
      const heartbeat = setInterval(() => {
        counter += 1
        writeFile(heartbeatPath, String(counter), 'utf8').catch(() => undefined)
      }, resolved.lockHeartbeatMs)
      heartbeat.unref()
      return async () => {
        clearInterval(heartbeat)
        const current = await readOwner(ownerPath)
        if (current?.token !== owner.token) return
        const tombstone = `${lockPath}.release-${owner.token}`
        try {
          await rename(lockPath, tombstone)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        await rm(tombstone, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Clock-free liveness: only this process's elapsed time is compared.
      // Heartbeat content proves a live holder; mtime covers legacy locks.
      const beat = await readFile(heartbeatPath, 'utf8').catch(() => undefined)
      const info = beat === undefined
        ? await stat(lockPath).catch(() => undefined)
        : undefined
      const observed = `${beat ?? ''}|${info?.mtimeMs ?? ''}`
      if (observed !== lastObserved) {
        lastObserved = observed
        lastChangeAt = Date.now()
      } else if (Date.now() - lastChangeAt > resolved.lockStaleMs) {
        const owner = await readOwner(ownerPath)
        if (!processIsAlive(owner)) {
          const tombstone = `${lockPath}.stale-${randomUUID()}`
          try {
            await rename(lockPath, tombstone)
            await rm(tombstone, { recursive: true, force: true })
          } catch (error) {
            if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          }
          continue
        }
        lastChangeAt = Date.now()
      }
      if (Date.now() >= deadline) {
        throw new Error(`memory-queue: timed out waiting for vault lock ${lockPath}`)
      }
      await sleep(resolved.lockRetryMs, signal)
    }
  }
}

/**
 * Register a `tools/execute` waterfall listener that serializes every call
 * whose name appears in `toolNames`. Non-matching calls pass straight through.
 * Queued calls respect the caller signal while waiting: an aborted caller
 * never dispatches. With `crossProcessLock`, the serialized section also
 * holds a vault lock directory so other processes cannot interleave. When
 * `laneArgument` names a string argument, calls carrying different values get
 * independent lanes and lock directories (`<vault>/.memory-queue.lanes/<hash>`)
 * while calls sharing a value still serialize.
 * @param ctx - registrant context carrying the tool registry events.
 * @param config - deployment's explicit queue configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.toolNames.length === 0) {
    throw new Error('memory-queue: toolNames must not be empty')
  }
  assertPositiveInteger('lockStaleMs', resolved.lockStaleMs)
  assertPositiveInteger('lockHeartbeatMs', resolved.lockHeartbeatMs)
  assertPositiveInteger('lockTimeoutMs', resolved.lockTimeoutMs)
  assertPositiveInteger('lockRetryMs', resolved.lockRetryMs)
  if (resolved.lockStaleMs <= resolved.lockHeartbeatMs * 2) {
    throw new Error('memory-queue: lockStaleMs must exceed twice lockHeartbeatMs so one missed heartbeat is not fatal')
  }
  const names = new Set(resolved.toolNames)
  const lanes = new Map<string, Promise<void>>()

  const laneKey = (exec: { arguments: unknown }): string => {
    if (resolved.laneArgument === '' || exec.arguments === null || typeof exec.arguments !== 'object') {
      return ''
    }
    const value = (exec.arguments as Record<string, unknown>)[resolved.laneArgument]
    return typeof value === 'string' ? value : ''
  }
  const lockPathFor = (vault: string, key: string): string => key === ''
    ? join(vault, LOCK_DIR)
    : join(vault, `${LOCK_DIR}.lanes`, `${createHash('sha1').update(key).digest('hex')}.lock`)

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (!names.has(exec.name)) return next()
    const key = laneKey(exec)
    const previous = lanes.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolve) => { release = resolve })
    const chained = previous.then(() => current)
    lanes.set(key, chained)
    try {
      await waitFor(previous, exec.signal)
      exec.signal.throwIfAborted()
      if (!resolved.crossProcessLock) return await next()
      const lockPath = lockPathFor(resolveMemoryVaultRoot(resolved.vaultRoot, exec), key)
      await mkdir(dirname(lockPath), { recursive: true })
      const unlock = await acquireLock(lockPath, resolved, exec.signal)
      try {
        return await next()
      } finally {
        await unlock()
      }
    } finally {
      release()
      if (lanes.get(key) === chained) lanes.delete(key)
    }
  })
}
