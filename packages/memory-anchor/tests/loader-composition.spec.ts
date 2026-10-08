import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as MemoryAnchor from '@jacklika/dsh-memory-anchor'

/**
 * Writes the `wiki_write` stub observed during a test, together with the run
 * context the registry pipeline supplied.
 */
const writeCalls: {
  id: string
  content: string
  mode?: string
  agent: unknown
  callId: unknown
}[] = []

/**
 * Every `tools/execute` dispatch a test observed, standing in for the memory
 * suite's scope/queue/git layers: a write the anchor performs without landing
 * here never reached the registry pipeline.
 */
const dispatches: { name: string; agent: unknown; callId: unknown }[] = []

/** Live agents by session id, as the Harness `agents` service resolves them. */
const agents = new Map<string, object>()

/**
 * Register one session's live agent stand-in and return it. The anchor must
 * take the dispatch scope from the `agents` service, not from the session.
 * @param id - the shared session/agent identity.
 * @returns the agent stand-in registered for that id.
 */
function liveAgent(id: string): object {
  const agent = { id, session: { id } }
  agents.set(id, agent)
  return agent
}

/**
 * Stand-in for a vault write tool. The run-context parameter is load-bearing:
 * the anchor must dispatch through the registry, so a caller that invokes this
 * definition directly arrives without a context and fails loudly here.
 */
const WikiWriteStub = {
  name: 'memory-anchor-test-stub',
  inject: ['tools'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'wiki_write',
      description: 'Test stub standing in for the vault write tool.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args: { id: string; content: string; mode?: string }, exec: ToolRunContext) {
        if (exec === undefined) {
          throw new Error('wiki_write stub ran without a run context: the caller bypassed ctx.tools.execute')
        }
        writeCalls.push({ ...args, agent: exec.agent, callId: exec.callId })
        return { written: true } as never
      },
    })))
  },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  writeCalls.length = 0
  dispatches.length = 0
  agents.clear()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the anchor beside the real prompt and tool registries.
 * @param anchorConfig - extra YAML lines for the plugin's config block.
 * @param vaultTool - whether to register the `wiki_write` stub.
 * @returns the booted context.
 */
async function boot(anchorConfig = '', vaultTool = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-anchor-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-memory-anchor'",
    anchorConfig,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  // Stand in for the Harness `agents` service and for the memory suite's
  // `tools/execute` layers: the anchor resolves its dispatch scope through the
  // first, and the second only observes a write that re-enters the pipeline.
  ctx.provide('agents', { get: (id: unknown) => agents.get(String(id)) })
  ctx.on('tools/execute', (exec, next) => {
    dispatches.push({ name: exec.name, agent: exec.agent, callId: exec.callId })
    return next()
  })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@jacklika/dsh-memory-anchor', MemoryAnchor],
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
  if (vaultTool) await ctx.plugin(WikiWriteStub)
  return ctx
}

/** Render the dynamic-context snapshot the Harness would put in the next prompt. */
async function promptContext(ctx: Context): Promise<string> {
  return renderContextSnapshot(await ctx.systemPrompt.assemble({}))
}

describe('memory-anchor real Loader composition through cordis.yml', () => {
  it('contributes both reminder lines to the prompt context', async () => {
    const ctx = await boot()
    const snapshot = await promptContext(ctx)
    expect(snapshot).toContain('memory_recall')
    expect(snapshot).toContain('memory_capture')
  })

  it('renders the same reminder on every prompt, surviving re-renders', async () => {
    const ctx = await boot()
    expect(await promptContext(ctx)).toBe(await promptContext(ctx))
    expect(await promptContext(ctx)).toContain('Memory discipline')
  })

  it('withdraws its contribution when the Loader fiber unloads', async () => {
    const ctx = await boot()
    expect(await promptContext(ctx)).toContain('Memory discipline')

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-memory-anchor')
    if (entry?.fiber === undefined) throw new Error('active memory-anchor entry missing')
    await entry.fiber.dispose()

    expect(await promptContext(ctx)).toBe('')
  })

  it('renders only the capture line when recallReminder is configured off', async () => {
    const ctx = await boot('  config:\n    recallReminder: false\n')
    const snapshot = await promptContext(ctx)
    expect(snapshot).not.toContain('memory_recall')
    expect(snapshot).toContain('memory_capture')
  })

  it('drops the contribution entirely when both reminders are off', async () => {
    const ctx = await boot('  config:\n    recallReminder: false\n    captureReminder: false\n')
    expect(await promptContext(ctx)).toBe('')
  })

  it('omits the Vault sentence when no vault write tool is registered', async () => {
    // A deployment without the memory suite must not point the model at tools
    // that do not exist, so the hint follows tool registration.
    const ctx = await boot()
    const snapshot = await promptContext(ctx)
    expect(snapshot).toContain('memory_capture')
    expect(snapshot).not.toContain('Vault')
  })

  it('includes the Vault sentence once a vault write tool is mounted', async () => {
    const ctx = await boot('', true)
    expect(await promptContext(ctx)).toContain('The Vault is the persistent record')
  })

  it('keeps the Vault sentence out when vaultHint is configured off, even with a vault tool mounted', async () => {
    const ctx = await boot('  config:\n    vaultHint: false\n', true)
    const snapshot = await promptContext(ctx)
    expect(snapshot).toContain('memory_capture')
    expect(snapshot).not.toContain('Vault')
  })

  it('honors a configured contextName and order', async () => {
    const ctx = await boot('  config:\n    contextName: custom:memory\n    order: 140\n')
    expect(await promptContext(ctx)).toContain('Memory discipline')
  })
})

/**
 * Emit one session event on the root context, the same way `dsh-session`'s
 * `ctx.sessions` store publishes `session/event` to descendant listeners.
 * @param ctx - the booted root context.
 * @param session - the session stand-in (only `id` is read).
 * @param type - the event type.
 * @param data - the event payload.
 */
function emitSessionEvent(ctx: Context, session: object, type: string, data: object = {}): void {
  ctx.emit('session/event', session, { type, seq: 1, time: Date.now(), data })
}

/** Yield once so the async `turn/end` capture can resolve its tool call. */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('memory-anchor auto-capture through the session/event feed', () => {
  it('appends a turn summary through wiki_write on turn/end', async () => {
    const ctx = await boot('', true)
    const session = { id: 'sess:abc/1' }
    const agent = liveAgent('sess:abc/1')
    emitSessionEvent(ctx, session, 'turn/start', { turn: 3 })
    emitSessionEvent(ctx, session, 'tool/call', { turn: 3, step: 1, name: 'wiki_search' })
    emitSessionEvent(ctx, session, 'tool/result', { turn: 3, step: 1 })
    emitSessionEvent(ctx, session, 'assistant/message', {
      turn: 3, step: 1, message: { content: [{ type: 'text', text: 'Answer recorded.' }] },
    })
    // The feed may wrap the reason in an object; the note must render the
    // string, never `[object Object]`.
    emitSessionEvent(ctx, session, 'turn/end', { turn: 3, reason: { reason: 'completed' } })
    await flush()

    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0].id).toBe('shared/notes/auto-capture-sess-abc-1.md')
    expect(writeCalls[0].mode).toBe('append')
    expect(writeCalls[0].content).toContain('turn 3 (completed)')
    expect(writeCalls[0].content).toContain('wiki_search')
    expect(writeCalls[0].content).toContain('Answer recorded.')

    // The write re-entered the registry carrying the session's own agent —
    // that is what lets the memory suite's scope, queue, and git layers see an
    // automatic capture exactly as they see a model-issued one.
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].name).toBe('wiki_write')
    expect(dispatches[0].agent).toBe(agent)
    expect(writeCalls[0].agent).toBe(agent)
    expect(String(writeCalls[0].callId)).not.toBe('')
  })

  it('writes nothing when the session has no live agent to dispatch as', async () => {
    // An agentless root call has no scope to resolve a relative vault root
    // against, so the anchor declines rather than writing outside the Vault.
    const ctx = await boot('', true)
    const session = { id: 'orphan' }
    emitSessionEvent(ctx, session, 'turn/start', { turn: 1 })
    emitSessionEvent(ctx, session, 'tool/call', { turn: 1, step: 1, name: 'wiki_search' })
    emitSessionEvent(ctx, session, 'tool/result', { turn: 1, step: 1 })
    emitSessionEvent(ctx, session, 'turn/end', { turn: 1, reason: 'completed' })
    await flush()

    expect(dispatches).toHaveLength(0)
    expect(writeCalls).toHaveLength(0)
  })

  it('skips a turn that did no observable work', async () => {
    const ctx = await boot('', true)
    const session = { id: 'idle' }
    liveAgent('idle')
    emitSessionEvent(ctx, session, 'turn/start', { turn: 1 })
    emitSessionEvent(ctx, session, 'turn/end', { turn: 1, reason: 'completed' })
    await flush()
    expect(writeCalls).toHaveLength(0)
  })

  it('writes nothing when autoCapture is configured off', async () => {
    const ctx = await boot('  config:\n    autoCapture: false\n', true)
    const session = { id: 'off' }
    liveAgent('off')
    emitSessionEvent(ctx, session, 'turn/start', { turn: 1 })
    emitSessionEvent(ctx, session, 'tool/call', { turn: 1, step: 1, name: 'wiki_search' })
    emitSessionEvent(ctx, session, 'tool/result', { turn: 1, step: 1 })
    emitSessionEvent(ctx, session, 'turn/end', { turn: 1, reason: 'completed' })
    await flush()
    expect(writeCalls).toHaveLength(0)
  })

  it('writes nothing when no vault write tool is mounted', async () => {
    const ctx = await boot()
    const session = { id: 'novault' }
    liveAgent('novault')
    emitSessionEvent(ctx, session, 'turn/start', { turn: 1 })
    emitSessionEvent(ctx, session, 'tool/call', { turn: 1, step: 1, name: 'wiki_search' })
    emitSessionEvent(ctx, session, 'tool/result', { turn: 1, step: 1 })
    emitSessionEvent(ctx, session, 'turn/end', { turn: 1, reason: 'completed' })
    await flush()
    expect(writeCalls).toHaveLength(0)
  })

  it('keeps per-session activity isolated', async () => {
    const ctx = await boot('', true)
    const a = { id: 'a' }
    const b = { id: 'b' }
    liveAgent('a')
    liveAgent('b')
    emitSessionEvent(ctx, a, 'turn/start', { turn: 1 })
    emitSessionEvent(ctx, b, 'turn/start', { turn: 1 })
    emitSessionEvent(ctx, a, 'tool/call', { turn: 1, step: 1, name: 'only_a' })
    emitSessionEvent(ctx, a, 'tool/result', { turn: 1, step: 1 })
    emitSessionEvent(ctx, b, 'turn/end', { turn: 1, reason: 'completed' })
    emitSessionEvent(ctx, a, 'turn/end', { turn: 1, reason: 'completed' })
    await flush()

    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0].id).toBe('shared/notes/auto-capture-a.md')
    expect(writeCalls[0].content).toContain('only_a')
  })

  it('stops observing after the Loader fiber unloads', async () => {
    const ctx = await boot('', true)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-memory-anchor')
    if (entry?.fiber === undefined) throw new Error('active memory-anchor entry missing')
    await entry.fiber.dispose()

    const session = { id: 'late' }
    liveAgent('late')
    emitSessionEvent(ctx, session, 'turn/start', { turn: 1 })
    emitSessionEvent(ctx, session, 'tool/call', { turn: 1, step: 1, name: 'wiki_search' })
    emitSessionEvent(ctx, session, 'tool/result', { turn: 1, step: 1 })
    emitSessionEvent(ctx, session, 'turn/end', { turn: 1, reason: 'completed' })
    await flush()
    expect(writeCalls).toHaveLength(0)
  })
})
