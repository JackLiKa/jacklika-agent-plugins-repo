import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as TodoAnchor from '@jacklika/dsh-todo-anchor'

/**
 * Stand-in for the Harness `todo_write` tool.
 *
 * The real tool ships outside this workspace, and the anchor only needs the
 * dispatch to happen: it reads the argument array, not the result.
 */
const TodoWriteStub = {
  name: 'todo-anchor-test-stub',
  inject: ['tools'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'todo_write',
      description: 'Test stub standing in for the Harness todo_write tool.',
      parameters: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string' },
              status: { type: 'string' },
            },
          },
          required: true,
          description: 'The full task list, replacing any previous one.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
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
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the anchor beside the real prompt and tool registries.
 * @returns the booted context, with the stub tool registered.
 */
async function boot(anchorConfig = ''): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-todo-anchor-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-todo-anchor'",
    anchorConfig,
    '',
  ].filter(line => line !== undefined).join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@jacklika/dsh-todo-anchor', TodoAnchor],
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
  await ctx.plugin(TodoWriteStub)
  return ctx
}

/** Dispatch one `todo_write` through the real registry and waterfall. */
async function writeTodos(
  ctx: Context,
  callId: string,
  todos: { content: string; status: string }[],
  agent?: { id: string },
) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'todo_write',
    arguments: { todos },
    ...(agent === undefined ? {} : { agent: agent as never }),
  })
}

/** Render the dynamic-context snapshot the Harness would put in the next prompt. */
async function promptContext(ctx: Context, scope?: object): Promise<string> {
  return renderContextSnapshot(await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope }))
}

describe('todo-anchor real Loader composition through cordis.yml', () => {
  it('anchors the list a successful write stored, in the prompt context', async () => {
    const ctx = await boot()
    expect(await promptContext(ctx)).toBe('')

    const result = await writeTodos(ctx, 't1', [
      { content: 'audit the parser', status: 'completed' },
      { content: 'fix the CRLF path', status: 'in_progress' },
    ])
    expect(result.isError).toBe(false)

    const snapshot = await promptContext(ctx)
    expect(snapshot).toContain('Current task list')
    expect(snapshot).toContain('- [x] audit the parser')
    expect(snapshot).toContain('- [~] fix the CRLF path')
  })

  it('carries the list across prompts, so a later turn still sees it', async () => {
    const ctx = await boot()
    await writeTodos(ctx, 't1', [{ content: 'only step', status: 'in_progress' }])

    // The Harness re-renders the context per prompt; two renders must agree,
    // which is what makes the list survive compaction and model switches.
    expect(await promptContext(ctx)).toBe(await promptContext(ctx))
    expect(await promptContext(ctx)).toContain('only step')
  })

  it('replaces the anchored list on the next write instead of appending', async () => {
    const ctx = await boot()
    await writeTodos(ctx, 't1', [{ content: 'first plan', status: 'pending' }])
    await writeTodos(ctx, 't2', [{ content: 'second plan', status: 'pending' }])

    const snapshot = await promptContext(ctx)
    expect(snapshot).toContain('second plan')
    expect(snapshot).not.toContain('first plan')
  })

  it('drops the contribution when the list is emptied, leaving no residue', async () => {
    const ctx = await boot()
    await writeTodos(ctx, 't1', [{ content: 'step', status: 'completed' }])
    expect(await promptContext(ctx)).toContain('step')

    await writeTodos(ctx, 't2', [])
    expect(await promptContext(ctx)).toBe('')
  })

  it('ignores a failed dispatch rather than anchoring a list the tool rejected', async () => {
    const ctx = await boot()
    // A missing argument reaches the tool as an error result; the anchor must
    // not adopt a list the registry never accepted.
    const failed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('bad'),
      name: 'todo_write',
      arguments: {},
    })
    expect(failed.isError).toBe(true)
    expect(await promptContext(ctx)).toBe('')
  })

  it('withdraws its contribution when the Loader fiber unloads', async () => {
    const ctx = await boot()
    await writeTodos(ctx, 't1', [{ content: 'step', status: 'in_progress' }])
    expect(await promptContext(ctx)).toContain('step')

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-todo-anchor')
    if (entry?.fiber === undefined) throw new Error('active todo-anchor entry missing')
    await entry.fiber.dispose()

    expect(await promptContext(ctx)).toBe('')
  })

  it('leaves dispatches of other tools alone', async () => {
    const ctx = await boot()
    const other = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('other'),
      name: 'not_a_todo_tool',
      arguments: { todos: [{ content: 'should not anchor', status: 'pending' }] },
    })
    expect(other.isError).toBe(true)
    expect(await promptContext(ctx)).toBe('')
  })

  it('isolates the anchored list per agent sessionId', async () => {
    const ctx = await boot()
    const agentA = { id: 'session-a' }
    const agentB = { id: 'session-b' }

    await writeTodos(ctx, 't1', [{ content: 'main-session step', status: 'in_progress' }], agentA)
    await writeTodos(ctx, 't2', [{ content: 'subagent step', status: 'in_progress' }], agentB)

    const a = await promptContext(ctx, agentA)
    const b = await promptContext(ctx, agentB)
    expect(a).toContain('main-session step')
    expect(a).not.toContain('subagent step')
    expect(b).toContain('subagent step')
    expect(b).not.toContain('main-session step')

    // Scope-less assemblies see the most recent write, matching the previous
    // single-list behavior for hosts that never scope assemblies.
    expect(await promptContext(ctx)).toContain('subagent step')
  })

  it('fails the dispatch loud when the configured argument is absent from the real schema', async () => {
    const ctx = await boot('  config:\n    todosArgument: items\n')
    const result = await writeTodos(ctx, 't1', [{ content: 'step', status: 'pending' }])
    expect(result.isError).toBe(true)
    expect(await promptContext(ctx)).toBe('')
  })
})
