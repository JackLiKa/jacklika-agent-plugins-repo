/**
 * Keeps the memory discipline in front of the model for every prompt.
 *
 * The suite's convention — search durable memory before acting, record
 * durable conclusions afterward — lives in the vault skill, but a skill only
 * applies when the model chooses to load it. This plugin contributes a short
 * always-on reminder as dynamic runtime context, which the Harness re-renders
 * into every prompt and keeps through compaction.
 *
 * Honest boundary: DSH exposes no `turn/start` or `turn/end` hook, so this is
 * a reminder layer only. It cannot perform recall or capture automatically —
 * nothing here intercepts a turn or writes the vault on its own.
 * @module @jacklika/dsh-memory-anchor
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
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
 * Register the memory-discipline reminder.
 * @param ctx - registrant context carrying the tool and prompt registries.
 * @param config - deployment configuration; defaults come from {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!Number.isFinite(resolved.order)) {
    throw new Error('memory-anchor: order must be a finite number')
  }

  ctx.systemPrompt.context({
    name: resolved.contextName,
    order: resolved.order,
    text: () => {
      // Mention the memory Vault only when a vault write tool is actually
      // mounted — otherwise the hint would send the model calling tools that
      // do not exist.
      const vaultAvailable = ctx.tools.get('wiki_write') !== undefined || ctx.tools.get('memory_capture') !== undefined
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
