import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as ToolMemoryQueue from '@jacklika/dsh-memory-queue'
import * as ToolMemoryFilesystem from '@jacklika/dsh-tool-memory-filesystem'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the memory-queue plugin configured to serialize
 * the test tool.
 * @param extraConfig - extra YAML lines appended under the plugin's `config:`.
 * @returns the booted context.
 */
async function boot(extraConfig: string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-queue-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-memory-queue'",
    '  config:',
    '    toolNames:',
    '      - slow_tool',
    ...extraConfig,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@jacklika/dsh-memory-queue', ToolMemoryQueue],
    ['@jacklika/dsh-tool-memory-filesystem', ToolMemoryFilesystem],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

interface Interval { label: string; start: number; end: number }

function registerSlowTool(ctx: Context, intervals: Interval[]): void {
  ctx.tools.register(defineTool({
    name: 'slow_tool',
    description: 'Records its dispatch interval for serialization tests.',
    parameters: {
      label: { type: 'string', required: true, description: 'Interval label.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const start = Date.now()
      await new Promise(resolve => setTimeout(resolve, 60))
      const end = Date.now()
      intervals.push({ label: args.label, start, end })
      return { label: args.label }
    },
  }))
}

function call(ctx: Context, callId: string, signal = new AbortController().signal) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(callId),
    name: 'slow_tool',
    arguments: { label: callId },
  })
}

describe('memory-queue real Loader composition through cordis.yml', () => {
  it('runs matching tool dispatches one at a time', async () => {
    const ctx = await boot()
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    const [r1, r2] = await Promise.all([call(ctx, 'first'), call(ctx, 'second')])
    expect(r1.isError).toBe(false)
    expect(r2.isError).toBe(false)

    const sorted = [...intervals].sort((a, b) => a.start - b.start)
    expect(sorted).toHaveLength(2)
    expect(sorted[1]!.start).toBeGreaterThanOrEqual(sorted[0]!.end)
  })

  it('withdraws its tools/execute wrapper when the Loader fiber unloads', async () => {
    const ctx = await boot()
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-memory-queue')
    if (entry?.fiber === undefined) throw new Error('active queue entry missing')
    await entry.fiber.dispose()
    const [first, second] = await Promise.all([call(ctx, 'first'), call(ctx, 'second')])
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    const sorted = [...intervals].sort((a, b) => a.start - b.start)
    expect(sorted[1]!.start).toBeLessThan(sorted[0]!.end)
  })

  it('removes an aborted waiter from its lane without blocking later calls', async () => {
    const ctx = await boot()
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)
    const controller = new AbortController()
    const first = call(ctx, 'first')
    const waiting = call(ctx, 'cancelled', controller.signal)
    controller.abort(new Error('cancel test'))
    const [firstResult, waitingResult] = await Promise.all([first, waiting])
    expect(firstResult.isError).toBe(false)
    expect(waitingResult.isError).toBe(true)
    const later = await call(ctx, 'later')
    expect(later.isError).toBe(false)
    expect(intervals.map(interval => interval.label)).toEqual(['first', 'later'])
  })

  it('runs different laneArgument values in parallel while same-lane calls serialize', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-queue-vault-'))
    const ctx = await boot([
      '    crossProcessLock: true',
      `    vaultRoot: ${vault}`,
      '    laneArgument: label',
    ])
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    const [r1, r2, r3] = await Promise.all([call(ctx, 'a'), call(ctx, 'b'), call(ctx, 'a')])
    expect(r1.isError).toBe(false)
    expect(r2.isError).toBe(false)
    expect(r3.isError).toBe(false)

    const sorted = [...intervals].sort((x, y) => x.start - y.start)
    // The two 'a' calls share a lane and cannot overlap...
    const as = intervals.filter(i => i.label === 'a').sort((x, y) => x.start - y.start)
    expect(as).toHaveLength(2)
    expect(as[1]!.start).toBeGreaterThanOrEqual(as[0]!.end)
    // ...but the 'b' call on its own lane overlaps the first 'a'.
    const b = intervals.find(i => i.label === 'b')!
    expect(b.start).toBeLessThan(as[0]!.end)
    expect(sorted).toHaveLength(3)
  })

  it('acquires and releases the vault lock directory when crossProcessLock is on', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-queue-vault-'))
    const ctx = await boot([
      '    crossProcessLock: true',
      `    vaultRoot: ${vault}`,
    ])
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    const result = await call(ctx, 'locked')
    expect(result.isError).toBe(false)
    await expect(stat(join(vault, '.memory-queue.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a stale foreign lock and fails fast on a fresh one', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-queue-vault-'))
    const ctx = await boot([
      '    crossProcessLock: true',
      `    vaultRoot: ${vault}`,
      '    lockStaleMs: 300',
      '    lockHeartbeatMs: 100',
      '    lockTimeoutMs: 1200',
      '    lockRetryMs: 50',
    ])
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    // A lock left by a dead process: its liveness token never changes, so it
    // is reclaimed after lockStaleMs of local observation.
    const lockPath = join(vault, '.memory-queue.lock')
    await mkdir(lockPath)
    const old = new Date(Date.now() - 60000)
    await utimes(lockPath, old, old)
    const reclaimed = await call(ctx, 'reclaim')
    expect(reclaimed.isError).toBe(false)

    // A legacy holder without a heartbeat file stays alive by refreshing the
    // directory mtime; liveness is change-detection on our local clock, never
    // an absolute-time comparison, so it survives past lockStaleMs.
    await mkdir(lockPath)
    const refresh = setInterval(() => {
      const now = new Date()
      void utimes(lockPath, now, now).catch(() => undefined)
    }, 100)
    try {
      const blocked = await call(ctx, 'blocked')
      expect(blocked.isError).toBe(true)
      await expect(stat(lockPath)).resolves.toBeDefined()
    } finally {
      clearInterval(refresh)
      await rm(lockPath, { recursive: true, force: true })
    }
  })

  it('does not reclaim a lock whose heartbeat counter keeps advancing', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-queue-vault-'))
    const ctx = await boot([
      '    crossProcessLock: true',
      `    vaultRoot: ${vault}`,
      '    lockStaleMs: 400',
      '    lockHeartbeatMs: 100',
      '    lockTimeoutMs: 700',
      '    lockRetryMs: 50',
    ])
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    // A foreign holder whose heartbeat counter advances must survive past
    // lockStaleMs: liveness is change-detection on our local clock, not an
    // mtime or absolute-time comparison.
    const lockPath = join(vault, '.memory-queue.lock')
    await mkdir(lockPath)
    let counter = 0
    const refresh = setInterval(() => {
      counter += 1
      void writeFile(join(lockPath, 'heartbeat'), String(counter), 'utf8').catch(() => undefined)
    }, 100)
    try {
      const blocked = await call(ctx, 'still-held')
      expect(blocked.isError).toBe(true)
      // The lock must still exist: it was never treated as stale.
      await expect(stat(lockPath)).resolves.toBeDefined()
    } finally {
      clearInterval(refresh)
      await rm(lockPath, { recursive: true, force: true })
    }
  })
})
