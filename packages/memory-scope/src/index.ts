/**
 * Partitions memory-tool write ids into per-agent namespaces. Mounting this
 * plugin rewrites the configured id argument of matching tool calls to
 * `<scopePrefix>/<agent key>/<id>` and re-dispatches the call as a nested
 * execution, so distinct agents physically cannot write the same note. Ids
 * under `sharedPrefixes` pass through untouched for the shared zone, where
 * `@jacklika/dsh-memory-queue` or a curator agent arbitrates. Read tools
 * are untouched: every agent still searches and reads the whole vault.
 * @module @jacklika/dsh-memory-scope
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-scope'

/** Services required so the listener registers after the tool registry exists. */
export const inject = ['tools']

/** How the mounted deployment treats write ids. */
export type ScopeRole = 'scoped' | 'curator'

/** Plugin configuration. */
export interface Config {
  /** Tool names whose id argument is namespaced per calling agent. */
  toolNames?: string[]
  /** Argument carrying the vault-relative note id. */
  idArgument?: string
  /**
   * Top-level vault directory holding every agent namespace. Must be a single
   * path segment of letters, digits, `.`, `_`, or `-`.
   */
  scopePrefix?: string
  /**
   * Id prefixes that form the shared zone: matching ids are NOT rewritten, so
   * they stay arbitrated by the queue lock or a curator agent.
   */
  sharedPrefixes?: string[]
  /**
   * `scoped` rewrites matching ids per calling agent; `curator` disables all
   * rewriting for deployments meant to write the shared zone directly.
   */
  role?: ScopeRole
}

/** Schemastery configuration for the memory scope consumer. */
export const Config: z<Config> = z.object({
  toolNames: z.array(z.string()).default(['wiki_write']),
  idArgument: z.string().default('id'),
  scopePrefix: z.string().default('agents'),
  sharedPrefixes: z.array(z.string()).default(['shared/']),
  role: z.union(['scoped', 'curator']).default('scoped'),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/**
 * Derive a path-safe namespace segment from the calling agent's session id.
 * @param exec - the pending call carrying the optional agent.
 * @returns a sanitized key, or `''` when the call has no agent.
 */
function agentKey(exec: ToolDispatchExecution): string {
  const raw = exec.agent?.id
  if (raw === undefined) return ''
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-')
  return cleaned === '' ? 'agent' : cleaned
}

/**
 * Register a `tools/execute` waterfall listener that re-dispatches matching
 * calls with a namespaced id. Re-dispatch is required because parsed arguments
 * are deep-frozen before wrappers run; the nested execution keeps `rootCallId`
 * and marks `parent` so the durable log records the real on-disk id. An id
 * already inside the caller's own namespace passes through, which also makes
 * the re-dispatched call idempotent.
 * @param ctx - registrant context carrying the tool registry events.
 * @param config - deployment's explicit scope configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.toolNames.length === 0) {
    throw new Error('memory-scope: toolNames must not be empty')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(resolved.scopePrefix)) {
    throw new Error('memory-scope: scopePrefix must be a single path segment of letters, digits, dot, underscore, or dash')
  }
  if (resolved.sharedPrefixes.some(prefix => !prefix.endsWith('/'))) {
    throw new Error('memory-scope: every sharedPrefixes entry must end with "/"')
  }
  const names = new Set(resolved.toolNames)
  const shared = resolved.sharedPrefixes

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (!names.has(exec.name) || resolved.role === 'curator') return next()
    const args = exec.arguments
    if (args === null || typeof args !== 'object') return next()
    const id = (args as Record<string, unknown>)[resolved.idArgument]
    if (typeof id !== 'string') return next()
    if (shared.some(prefix => id.startsWith(prefix))) return next()
    const key = agentKey(exec)
    if (key === '') return next()
    const ownPrefix = `${resolved.scopePrefix}/${key}/`
    if (id.startsWith(ownPrefix)) return next()
    const scopedArgs = { ...(args as Record<string, unknown>), [resolved.idArgument]: `${ownPrefix}${id}` }
    return ctx.tools.execute({
      callId: ToolCallId(`${exec.callId}:scoped`),
      rootCallId: exec.rootCallId,
      name: exec.name,
      arguments: scopedArgs,
      parent: exec.token,
      signal: exec.signal,
      ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
    })
  })
}
