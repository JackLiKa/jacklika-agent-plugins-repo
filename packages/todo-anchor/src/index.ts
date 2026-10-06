/**
 * Keeps the session task list in front of the model for the whole task.
 *
 * `todo_write` replaces the entire list, no tool reads it back, and nothing in
 * the Harness re-injects it. A list written once and never refreshed therefore
 * keeps claiming whatever it said last, and a resumed, forked, or compacted
 * session can lose even that. This plugin closes the display half of that gap:
 * it observes successful `todo_write` dispatches, remembers the list in
 * process, and contributes it as dynamic runtime context, which the Harness
 * re-renders into every prompt and marks as superseding earlier snapshots.
 *
 * The durable half stays with the memory Vault: this plugin never records
 * history, and the reminder it renders says so.
 *
 * Scope: captured lists are keyed by `exec.agent.id` (the session id), so
 * concurrent sessions (main thread and subagents) each render their own list.
 * The assembly context's `scope` IS the assembling agent, which carries the
 * same id; a scope-less assembly falls back to the most recent write.
 * @module @jacklika/dsh-todo-anchor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'todo-anchor'

/** Services required so the listener and the prompt contribution register in order. */
export const inject = ['tools', 'systemPrompt']

/** One task-list entry, as the observed tool stores it. */
export interface TodoItem {
  /** Human-readable task text. */
  content: string
  /** Lifecycle state; unknown values render as "not started". */
  status: string
}

/** Plugin configuration. */
export interface Config {
  /** Tool whose successful dispatches refresh the anchored list. */
  toolName?: string
  /** Argument of that tool carrying the entry array. */
  todosArgument?: string
  /** Name of the registered dynamic prompt context. */
  contextName?: string
  /**
   * Placement order among dynamic contexts. The Harness reserves 110-120
   * (sandbox policy, approval policy, subagent delegation); a later order keeps
   * this list after the policy context it qualifies.
   */
  order?: number
  /** Render the write-back rule alongside the list. */
  reminder?: boolean
  /** Cap on rendered entries; later entries collapse into a count. */
  maxItems?: number
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  toolName: z.string().default('todo_write'),
  todosArgument: z.string().default('todos'),
  contextName: z.string().default('todo-anchor:list'),
  order: z.number().default(130),
  reminder: z.boolean().default(true),
  maxItems: z.number().default(50),
})

/** Configuration after schemastery applied the defaults. */
interface ResolvedConfig {
  toolName: string
  todosArgument: string
  contextName: string
  order: number
  reminder: boolean
  maxItems: number
}

/** Checkbox glyph per known status; anything else reads as not started. */
const STATUS_MARK: Record<string, string> = {
  completed: 'x',
  in_progress: '~',
  pending: ' ',
}

/**
 * Extract the durable session identity from an agent or scope object.
 *
 * Harness `Agent` exposes `id` (a branded session-id string equal to
 * `agent.session.id`); the desk-era shape carried `sessionId` instead, so both
 * are honored.
 * @param value - the exec's `agent` or the assembly context's `scope`.
 * @returns the session id, or `undefined` when the value is not an agent.
 */
function sessionKeyOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { id?: unknown; sessionId?: unknown }
  for (const id of [candidate.id, candidate.sessionId]) {
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/**
 * Whether a dispatched value is a task-list entry.
 * @param value - one element of the observed argument array.
 * @returns true when it carries the string `content`/`status` pair.
 */
export function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry['content'] === 'string' && typeof entry['status'] === 'string'
}

/**
 * Render the anchored list, or `''` when there is nothing to anchor.
 *
 * An empty string is deliberate: the Harness drops zero-length context
 * contributions, so a session that never wrote a task list shows no trace of
 * this plugin.
 * @param todos - entries in `todo_write` order.
 * @param options - rendering switches already resolved from configuration.
 * @returns the context text, or `''`.
 */
export function renderTodoContext(
  todos: readonly TodoItem[],
  options: { reminder: boolean; maxItems: number; vaultHint?: boolean },
): string {
  if (todos.length === 0) return ''
  const shown = todos.slice(0, options.maxItems)
  const lines = shown.map(todo => `- [${STATUS_MARK[todo.status] ?? ' '}] ${todo.content}`)
  const omitted = todos.length - shown.length
  if (omitted > 0) lines.push(`- … and ${omitted} more not shown`)
  const body = ['Current task list (kept in sync by the `todo_write` tool).', '', ...lines]
  if (options.reminder) {
    body.push(
      '',
      'Re-write this list as soon as an item completes. It is a progress display, not a record:',
      'no tool reads it back and nothing else re-injects it, so a list left stale is',
      options.vaultHint === false
        ? 'indistinguishable from real progress.'
        : 'indistinguishable from real progress. Durable decisions belong in the memory Vault.',
    )
  }
  return body.join('\n')
}

/**
 * Register the task-list anchor.
 * @param ctx - registrant context carrying the tool and prompt registries.
 * @param config - deployment configuration; defaults come from {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!Number.isFinite(resolved.order)) {
    throw new Error('todo-anchor: order must be a finite number')
  }
  if (!Number.isInteger(resolved.maxItems) || resolved.maxItems < 1) {
    throw new Error('todo-anchor: maxItems must be a positive integer')
  }

  /**
   * Fail loud when the configured argument name does not match the observed
   * tool's compiled parameter schema; a silent mismatch would leave the plugin
   * permanently inert. Verified against `@deepseek-ai/dsh-tool-todo`
   * (`todo_write` takes `todos: {content, status}[]`).
   */
  let schemaChecked = false
  const assertObservedTool = () => {
    if (schemaChecked) return
    const definition = ctx.tools.get(resolved.toolName)
    if (definition === undefined) return // not registered yet; retry on next dispatch
    schemaChecked = true
    const params = definition.parameters as Record<string, unknown> | undefined
    const props = params?.['properties'] as Record<string, unknown> | undefined
    const arg = props?.[resolved.todosArgument] as Record<string, unknown> | undefined
    const itemProps = (arg?.['items'] as Record<string, unknown> | undefined)?.['properties'] as
      | Record<string, { type?: string } | undefined>
      | undefined
    const ok =
      arg?.['type'] === 'array' &&
      itemProps?.['content']?.type === 'string' &&
      itemProps?.['status']?.type === 'string'
    if (!ok) {
      throw new Error(
        `todo-anchor: configured todosArgument "${resolved.todosArgument}" does not match the "${resolved.toolName}" tool's parameter schema`,
      )
    }
  }
  assertObservedTool()

  /** Per-session lists keyed by sessionId; durable across agent re-creation. */
  const bySession = new Map<string, TodoItem[]>()
  /** The most recent list observed, for assemblies without a session scope. */
  let latest: TodoItem[] = []

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (exec.name === resolved.toolName) assertObservedTool()
    const result = await next()
    if (exec.name !== resolved.toolName || result.isError) return result
    const args = exec.arguments
    if (args === null || typeof args !== 'object') return result
    const raw = (args as Record<string, unknown>)[resolved.todosArgument]
    if (!Array.isArray(raw)) return result
    const list = raw.filter(isTodoItem).map(todo => ({ content: todo.content, status: todo.status }))
    latest = list
    const sessionId = sessionKeyOf(exec.agent)
    if (sessionId !== undefined) bySession.set(sessionId, list)
    return result
  })

  ctx.systemPrompt.context({
    name: resolved.contextName,
    order: resolved.order,
    text: (context: { scope?: object }) => {
      const sessionId = sessionKeyOf(context.scope)
      const todos = sessionId !== undefined ? (bySession.get(sessionId) ?? []) : latest
      // Mention the memory Vault only when a vault tool is actually mounted —
      // otherwise the hint would send the model calling tools that do not exist.
      const vaultHint = ctx.tools.get('wiki_write') !== undefined || ctx.tools.get('memory_capture') !== undefined
      return renderTodoContext(todos, { reminder: resolved.reminder, maxItems: resolved.maxItems, vaultHint })
    },
  })
}
