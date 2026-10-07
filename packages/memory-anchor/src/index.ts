/**
 * Keeps the memory discipline in front of the model for every prompt.
 *
 * The suite's convention — search durable memory before acting, record
 * durable conclusions afterward — lives in the vault skill, but a skill only
 * applies when the model chooses to load it. This plugin contributes a short
 * always-on reminder as dynamic runtime context, which the Harness re-renders
 * into every prompt and keeps through compaction.
 *
 * The reminder cannot recall for the model. Capture, however, CAN be
 * automated for real: the Harness publishes the session event feed as a
 * Cordis event (`session/event`, carrying `turn/start`, `tool/call`,
 * `tool/result`, `assistant/message`, and `turn/end`), which is exactly how
 * `dsh-workspace-changes` snapshots turns. With `autoCapture` enabled this
 * plugin tracks each session's open turn and, on `turn/end`, appends a
 * heuristic summary through the `wiki_write` tool. That is real automation,
 * not a reminder — but it is a mechanical summary (tool names, excerpts),
 * not a model-curated note; durable conclusions still deserve an explicit
 * `memory_capture`/`wiki_write` call.
 * @module @jacklika/dsh-memory-anchor
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { formatBeijingTime } from '@jacklika/dsh-memory-time'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-anchor'

/** Services required so the prompt contribution registers in order. */
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration. */
export interface Config {
  /** Name of the registered dynamic prompt context. */
  contextName?: string
  /**
   * Placement order among dynamic contexts. The Harness reserves 110-120
   * (sandbox policy, approval policy, subagent delegation) and todo-anchor
   * uses 130; this reminder sits after them.
   */
  order?: number
  /** Render the recall-first reminder line. */
  recallReminder?: boolean
  /** Render the capture-on-finish reminder line. */
  captureReminder?: boolean
  /** Recall reminder text (the vault-tool names are supplied by the config). */
  recallText?: string
  /** Capture reminder text; the Vault sentence is appended only when a vault write tool is mounted. */
  captureText?: string
  /**
   * Whether the Vault sentence may appear at all. The runtime check (whether
   * `wiki_write` or `memory_capture` is registered) still applies on top of
   * this flag.
   */
  vaultHint?: boolean
  /**
   * Append a heuristic per-turn summary to the vault on `turn/end`. Subscribes
   * to the Cordis `session/event` feed and writes through `wiki_write`; skips
   * turns with no observed activity and sessions without a vault write tool.
   */
  autoCapture?: boolean
  /**
   * Vault note prefix for auto-captured summaries; the session id is appended
   * (`<prefix>-<sessionId>.md`).
   */
  captureNotePrefix?: string
  /** Maximum characters kept for each message excerpt in a turn summary. */
  excerptChars?: number
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  contextName: z.string().default('memory-anchor:discipline'),
  order: z.number().default(135),
  recallReminder: z.boolean().default(true),
  captureReminder: z.boolean().default(true),
  recallText: z.string().default(
    'Memory discipline: search durable memory with `memory_recall`/`wiki_search` (2-4 keywords) before answering or acting.',
  ),
  captureText: z.string().default(
    'When a task ends with durable conclusions, record them with `memory_capture`/`wiki_write`.',
  ),
  vaultHint: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  captureNotePrefix: z.string().default('shared/notes/auto-capture'),
  excerptChars: z.number().default(200),
})

/** Configuration after schemastery applied the defaults. */
interface ResolvedConfig {
  contextName: string
  order: number
  recallReminder: boolean
  captureReminder: boolean
  recallText: string
  captureText: string
  vaultHint: boolean
  autoCapture: boolean
  captureNotePrefix: string
  excerptChars: number
}

/**
 * Minimal structural view of the session event feed. The Harness freezes
 * every event and validates payloads upstream (`dsh-session` runs a
 * pre-commit check before any `session/event` dispatch), so observers only
 * read `type`, `seq`, `time`, and `data`.
 */
interface SessionEventLike {
  type?: string
  data?: Record<string, unknown>
}

/** Per-session state for the open turn, keyed by the live Session object. */
interface TurnActivity {
  turn: number
  toolNames: string[]
  toolResults: number
  lastAssistant: string
  userExcerpt: string
}

function emptyTurn(turn: number): TurnActivity {
  return { turn, toolNames: [], toolResults: 0, lastAssistant: '', userExcerpt: '' }
}

/**
 * Extract the visible text of a session-carried message. Message events store
 * `{ message: { content: Block[] } }` while `user/message` stores the message
 * itself; non-text blocks are skipped.
 * @param value - the event payload or embedded message.
 * @param max - excerpt length cap.
 * @returns the joined text, truncated to `max` characters.
 */
function messageText(value: unknown, max: number): string {
  const record = value as { message?: { content?: unknown }; content?: unknown } | undefined
  const content = record?.content ?? record?.message?.content
  if (!Array.isArray(content)) return ''
  const text = content
    .map(block => (block as { type?: string; text?: string }))
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join(' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Render the discipline reminder, or `''` when nothing should anchor.
 *
 * An empty string is deliberate: the Harness drops zero-length context
 * contributions, so a deployment with both reminders off shows no trace of
 * this plugin.
 * @param options - rendering switches already resolved from configuration.
 * @returns the context text, or `''`.
 */
export function renderMemoryDiscipline(options: {
  recallReminder: boolean
  captureReminder: boolean
  recallText: string
  captureText: string
  vaultHint?: boolean
}): string {
  const lines: string[] = []
  if (options.recallReminder) lines.push(options.recallText)
  if (options.captureReminder) {
    lines.push(
      options.vaultHint === false
        ? options.captureText
        : `${options.captureText} The Vault is the persistent record of this workspace.`,
    )
  }
  return lines.join('\n')
}

/**
 * Register the memory-discipline reminder and the turn-summary capture.
 * @param ctx - registrant context carrying the tool and prompt registries.
 * @param config - deployment configuration; defaults come from {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!Number.isFinite(resolved.order)) {
    throw new Error('memory-anchor: order must be a finite number')
  }

  if (resolved.autoCapture) {
    // Session objects are store-owned; a WeakMap keyed on them retires all
    // state when a session is disposed and collected — no `session/disposed`
    // bookkeeping needed. `ctx.on` unregisters with this fiber.
    const turns = new WeakMap<object, TurnActivity>()
    ctx.on('session/event', (session, raw: unknown) => {
      const event = raw as SessionEventLike
      const activity = event.type === 'turn/start'
        ? emptyTurn(Number(event.data?.turn ?? 0))
        : turns.get(session)
      if (activity === undefined) return
      if (event.type === 'turn/start') turns.set(session, activity)
      const data = event.data ?? {}
      if (event.type === 'tool/call' && typeof data.name === 'string') activity.toolNames.push(data.name)
      else if (event.type === 'tool/result') activity.toolResults += 1
      else if (event.type === 'assistant/message') {
        const text = messageText(data.message, resolved.excerptChars)
        if (text !== '') activity.lastAssistant = text
      } else if (event.type === 'user/message' && activity.userExcerpt === '') {
        activity.userExcerpt = messageText(data, resolved.excerptChars)
      } else if (event.type === 'turn/end') {
        void captureTurn(ctx, resolved, session, activity, String(data.reason ?? 'unknown'))
      }
    })
  }

  ctx.systemPrompt.context({
    name: resolved.contextName,
    order: resolved.order,
    text: () => {
      // Mention the memory Vault only when a vault write tool is actually
      // mounted — otherwise the hint would send the model calling tools that
      // do not exist.
      const vaultAvailable = vaultWriteTool(ctx) !== undefined || ctx.tools.get('memory_capture') !== undefined
      return renderMemoryDiscipline({
        recallReminder: resolved.recallReminder,
        captureReminder: resolved.captureReminder,
        recallText: resolved.recallText,
        captureText: resolved.captureText,
        vaultHint: resolved.vaultHint && vaultAvailable,
      })
    },
  })
}

/** The tool shape needed to append a note; `wiki_write` takes `{id, content, mode}`. */
interface VaultWriteTool {
  execute: (args: { id: string; content: string; mode?: string }) => Promise<unknown> | unknown
}

/**
 * Resolve the mounted `wiki_write` tool, or `undefined` when the memory vault
 * is not mounted in this profile.
 * @param ctx - registrant context carrying the tool registry.
 * @returns the tool, or `undefined`.
 */
function vaultWriteTool(ctx: Context): VaultWriteTool | undefined {
  return ctx.tools.get('wiki_write') as VaultWriteTool | undefined
}

/**
 * Sanitize a session id into a note-id-safe component: the vault resolves
 * ids lexically inside its root, so separators must not survive.
 * @param session - the emitting Session (only `id` is read).
 * @returns a `[A-Za-z0-9_-]`-safe id, or `unknown`.
 */
function sessionNoteId(session: unknown): string {
  const raw = (session as { id?: unknown } | undefined)?.id
  const safe = String(raw ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe === '' ? 'unknown' : safe
}

/**
 * Append the closed turn's mechanical summary through `wiki_write`. Skips
 * turns that did no observable work (no tool activity and no messages) and
 * deployments without a vault write tool; write failures are logged, never
 * thrown into the session feed.
 * @param ctx - registrant context.
 * @param resolved - resolved plugin configuration.
 * @param session - the session whose turn ended.
 * @param activity - tracked activity of the just-closed turn.
 * @param reason - the `turn/end` reason string.
 */
async function captureTurn(
  ctx: Context,
  resolved: ResolvedConfig,
  session: unknown,
  activity: TurnActivity,
  reason: string,
): Promise<void> {
  const write = vaultWriteTool(ctx)
  const didWork = activity.toolNames.length > 0 || activity.toolResults > 0
    || activity.lastAssistant !== '' || activity.userExcerpt !== ''
  if (write === undefined || !didWork) return
  const lines = [
    `## ${formatBeijingTime(new Date())} — turn ${activity.turn} (${reason})`,
    '',
    activity.toolNames.length > 0
      ? `- Tools: ${activity.toolNames.join(', ')} (${activity.toolResults} result${activity.toolResults === 1 ? '' : 's'})`
      : '- Tools: none',
    activity.userExcerpt === '' ? '' : `- User: "${activity.userExcerpt}"`,
    activity.lastAssistant === '' ? '' : `- Last assistant: "${activity.lastAssistant}"`,
  ].filter(line => line !== '')
  try {
    await write.execute({
      id: `${resolved.captureNotePrefix}-${sessionNoteId(session)}.md`,
      mode: 'append',
      content: lines.join('\n'),
    })
  } catch (error) {
    ctx.logger?.warn(`memory-anchor: auto-capture of turn ${activity.turn} failed: ${String(error)}`)
  }
}
