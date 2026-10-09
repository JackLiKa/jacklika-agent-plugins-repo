/**
 * Curator tools for the DSH memory vault. `memory_recall` is meant to run at
 * the start of a task so the agent does not ask the user to repeat context.
 * `memory_capture` runs at the end of significant work: it derives a stable
 * note id from the title, checks for conflicts with existing notes, asks the
 * user for approval when one is found, and writes the captured knowledge to the
 * shared curated zone.
 * @module @jacklika/dsh-memory-curator
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { formatBeijingTime } from '@jacklika/dsh-memory-time'
import yaml from 'js-yaml'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-curator'

/** Services required by the curator tools. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /**
   * What to do when a capture matches an existing note. `ask` requests user
   * approval through the DSH approval seam before writing. `skip` silently
   * aborts the write so nothing is overwritten in headless or CI runs.
   */
  conflictPolicy?: 'ask' | 'skip'
  /**
   * Default zone for captured notes. `shared` puts them under the configured
   * `notesDir` and makes them visible to every agent and session. `private`
   * leaves the id unchanged so `memory-scope` routes it under the current
   * agent's namespace.
   */
  defaultScope?: 'shared' | 'private'
  /** Vault-relative directory where shared curated notes live. */
  notesDir?: string
}

/** Schemastery configuration for the memory curator consumer. */
export const Config: z<Config> = z.object({
  conflictPolicy: z.union(['ask', 'skip']).default('ask'),
  defaultScope: z.union(['shared', 'private']).default('shared'),
  notesDir: z.string().default('shared/notes'),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** One hit returned by `wiki_search`. */
interface SearchHit {
  id: string
  title: string
  score: number
  backlinks: string[]
}

/** Result of a nested tool call after parsing its JSON text content. */
interface WriteResult {
  id: string
  mode: string
  bytes: number
}

/**
 * Fold a title to its comparison form: NFC, case-insensitive, every run of
 * characters that are neither Unicode letters nor digits collapsed to one
 * space. Keeping `\p{L}` means CJK and other non-Latin titles stay distinct
 * instead of folding to the empty string they would all share.
 */
function foldTitle(title: string): string {
  return title.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function slugify(title: string): string {
  const slug = foldTitle(title).replace(/ /g, '-')
  // Emoji-only and punctuation-only titles fold to nothing; a stable content
  // hash keeps them addressable and separate rather than sharing a bare ".md".
  if (slug === '') return `note-${createHash('sha256').update(title.normalize('NFC')).digest('hex').slice(0, 12)}`
  return slug
}

function ensureMdExtension(id: string): string {
  return id.endsWith('.md') ? id : `${id}.md`
}

function resolveNoteId(
  id: string | undefined,
  title: string,
  scope: 'shared' | 'private',
  notesDir: string,
): string {
  if (id !== undefined && id !== '') {
    const withExt = ensureMdExtension(id)
    if (scope === 'private') return withExt
    return withExt.startsWith('shared/') ? withExt : `${notesDir}/${withExt.replace(/^\//, '')}`
  }
  const slug = slugify(title)
  return scope === 'private' ? `${slug}.md` : `${notesDir}/${slug}.md`
}

function textFromContent(content: ContentBlock[]): string {
  return content
    .map(block => {
      const maybe = block as { type?: unknown; text?: unknown }
      return maybe.type === 'text' && typeof maybe.text === 'string' ? maybe.text : ''
    })
    .join('')
}

async function callTool<T>(
  ctx: Context,
  exec: ToolRunContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await ctx.tools.execute({
    callId: ToolCallId(`${exec.callId}:${toolName}:${randomUUID()}`),
    rootCallId: exec.rootCallId,
    name: toolName,
    arguments: args,
    parent: exec.token,
    signal: exec.signal,
    ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
  })
  if (result.isError) {
    throw new Error(`memory-curator: nested ${toolName} failed: ${result.error.message}`)
  }
  return JSON.parse(textFromContent(result.content) || 'null') as T
}

function findConflicts(targetId: string, title: string, hits: SearchHit[]): SearchHit[] {
  const normalized = foldTitle(title)
  const target = targetId.normalize('NFC').toLowerCase()
  return hits.filter(hit => {
    if (hit.id.normalize('NFC').toLowerCase() === target) return true
    // A title that folds to nothing carries no identity; matching it would make
    // every untitled note a conflict with every other one.
    return normalized !== '' && foldTitle(hit.title) === normalized
  })
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  return [...new Map(hits.map(hit => [hit.id, hit])).values()]
}

/**
 * Register `memory_recall` and `memory_capture` on the tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit curator configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.get('tools') as { execute?: unknown } | undefined
  if (typeof tools?.execute !== 'function') {
    ctx.logger?.warn('memory-curator: ctx.tools.execute unavailable; curator tools will not register.')
    return
  }

  const resolved = config as ResolvedConfig
  const approval = ctx.get('approval') as ApprovalService | undefined

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Search the memory vault for prior notes related to the current task or topic. Call this at the start of a development task to avoid asking the user to repeat context that is already captured. Query terms are OR-matched and ranked by field-weighted relevance, so partial matches still return. Returns matching note ids, titles, scores, and backlink counts.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keywords, concepts, or the task description to search for in the vault.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const hits = await callTool<SearchHit[]>(ctx, exec, 'wiki_search', { query: args.query })
      return {
        query: args.query,
        hits: hits.slice(0, 20),
        total: hits.length,
      } as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_capture',
    description: 'Persist durable knowledge to the memory vault. Call this at the end of a significant task to capture decisions, discovered APIs, project conventions, fixes, or user preferences. It checks for conflicting notes, asks for approval when a conflict is found, and writes the captured note to the shared curated zone by default.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Short human-readable title for the knowledge entry. Used to derive the note id when id is omitted.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'The durable knowledge to record: the decision, API, convention, or fix in concise Markdown.',
      },
      details: {
        type: 'string',
        description: 'Optional additional Markdown context (error traces, alternatives considered, links).',
      },
      id: {
        type: 'string',
        description: 'Optional explicit vault-relative note id. If omitted, it is derived from the title as <notesDir>/<slug>.md.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for the note frontmatter (e.g. ["api", "decision", "bugfix"]).',
      },
      scope: {
        type: 'string',
        enum: ['shared', 'private'],
        description: 'Whether the note lives in the shared curated zone or the private agent namespace. Defaults to shared.',
      },
      mode: {
        type: 'string',
        enum: ['append', 'overwrite'],
        description: 'When a conflict is approved or the note exists, append adds a timestamped section; overwrite replaces the whole body. Defaults to append.',
      },
      conflictPolicy: {
        type: 'string',
        enum: ['ask', 'skip'],
        description: 'Override the deployment conflict policy for this capture: ask for approval on conflict, or skip the write.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const scope = args.scope ?? resolved.defaultScope
      const notesDir = scope === 'shared' ? resolved.notesDir : ''
      const targetId = resolveNoteId(args.id, args.title, scope, notesDir)
      const mode = args.mode ?? 'append'
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : []

      const [titleHits, idHits] = await Promise.all([
        callTool<SearchHit[]>(ctx, exec, 'wiki_search', { query: args.title }),
        callTool<SearchHit[]>(ctx, exec, 'wiki_search', { query: targetId }),
      ])

      const conflicts = dedupeHits(findConflicts(targetId, args.title, [...titleHits, ...idHits]))
      const conflictExists = conflicts.length > 0
      const finalId = conflicts[0]?.id ?? targetId

      if (conflictExists) {
        const policy = args.conflictPolicy ?? resolved.conflictPolicy
        if (policy === 'skip') {
          return {
            written: false,
            id: finalId,
            conflict: true,
            reason: 'skipped by conflictPolicy=skip',
          } as unknown as JsonValue
        }
        if (approval === undefined || exec.agent === undefined) {
          return {
            written: false,
            id: finalId,
            conflict: true,
            reason: 'approval service or agent unavailable; set conflictPolicy=skip to allow silent skip in headless mode',
          } as unknown as JsonValue
        }
        const conflictList = conflicts.map(c => `- ${c.id} (${c.title})`).join('\n')
        const outcome = await approval.request({
          agent: exec.agent as Agent,
          toolName: 'memory_capture',
          callId: exec.callId,
          reason: `memory_capture conflicts with existing note(s):\n${conflictList}\nProposed action: ${mode === 'append' ? 'append a new section to' : 'overwrite'} "${finalId}".`,
          displayReason: {
            en: `Memory capture conflicts with existing note(s):\n${conflictList}\nAllow ${mode} to "${finalId}"?`,
          },
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          return {
            written: false,
            id: finalId,
            conflict: true,
            approval: outcome,
            reason: 'user did not approve the conflict',
          } as unknown as JsonValue
        }
      }

      const now = formatBeijingTime(new Date())
      const detailsText = args.details ? `\n\n## Details\n\n${args.details}` : ''
      const appendContent = `${args.summary}${detailsText}\n`
      const frontmatter = {
        title: args.title,
        tags,
        created: now,
      }
      const newNoteContent = `---\n${yaml.dump(frontmatter).trim()}\n---\n\n# ${args.title}\n\n${appendContent}`

      const appending = conflictExists && mode === 'append'
      const content = appending ? appendContent : newNoteContent
      const writeMode: 'append' | 'overwrite' = appending ? 'append' : 'overwrite'

      await callTool<WriteResult>(ctx, exec, 'wiki_write', {
        id: finalId,
        content,
        mode: writeMode,
      })

      return {
        written: true,
        id: finalId,
        mode: writeMode,
        conflict: conflictExists,
      } as unknown as JsonValue
    },
  })))
}
