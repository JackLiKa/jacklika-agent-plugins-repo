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
  /**
   * Optional compaction of per-turn auto-capture notes. Disabled by default;
   * when enabled, old session captures are archived and no longer appear in
   * default search results.
   */
  autoCaptureCompact?: AutoCaptureCompactConfig
}

/** Configuration for the optional auto-capture compaction pass. */
export interface AutoCaptureCompactConfig {
  /**
   * Whether the compaction pass is active. Default false: without explicit
   * opt-in, `memory_compact` is a no-op so a caller cannot accidentally archive
   * human-written notes.
   */
  enabled?: boolean
  /**
   * How many recent auto-capture sessions to keep in the active vault. Older
   * captures are moved to `archive/` by `memory_forget`. Must be >= 1 when
   * enabled.
   */
  keepSessions?: number
}

/** Schemastery configuration for the memory curator consumer. */
export const Config: z<Config> = z.object({
  conflictPolicy: z.union(['ask', 'skip']).default('ask'),
  defaultScope: z.union(['shared', 'private']).default('shared'),
  notesDir: z.string().default('shared/notes'),
  autoCaptureCompact: z.object({
    enabled: z.boolean().default(false),
    keepSessions: z.number().default(0),
  }).default({ enabled: false, keepSessions: 0 }),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config> & {
  autoCaptureCompact: Required<AutoCaptureCompactConfig>
}

/** Result of archiving one auto-capture note via `memory_forget`. */
interface ForgetResult {
  forgotten: boolean
  id: string
  archivedTo: string
  version: string
}

/** One hit returned by `wiki_search`. */
interface SearchHit {
  id: string
  title: string
  score: number
  backlinks: string[]
}

/** The `wiki_search` envelope: one page of hits plus the pre-cap match count. */
interface SearchPage {
  hits: SearchHit[]
  total: number
  truncated: boolean
}

/** Result of a nested tool call after parsing its JSON text content. */
interface WriteResult {
  id: string
  mode: string
  bytes: number
  version: string
  created?: string
  updated?: string
  committed?: boolean
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

const MAX_SLUG_LENGTH = 100

function hashTail(title: string, length = 12): string {
  return createHash('sha256').update(title.normalize('NFC')).digest('hex').slice(0, length)
}

function slugify(title: string): string {
  let slug = foldTitle(title).replace(/ /g, '-')
  // Emoji-only and punctuation-only titles fold to nothing; a stable content
  // hash keeps them addressable and separate rather than sharing a bare ".md".
  if (slug === '') return `note-${hashTail(title)}`
  // Keep generated filenames bounded on all platforms. A long CJK title would
  // otherwise create a very long filename; truncate and append a hash so the
  // id remains deterministic and collision-resistant.
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = `${slug.slice(0, 64)}-${hashTail(title)}`
  }
  return slug
}

function ensureMdExtension(id: string): string {
  return id.endsWith('.md') ? id : `${id}.md`
}

function isSafeNoteId(id: string): boolean {
  if (id === '' || id.startsWith('/') || id.startsWith('\\') || /^[A-Za-z]:/.test(id)) return false
  if (id.includes('\\')) return false
  return !id.split('/').some(segment => segment === '..' || segment === '.')
}

function resolveNoteId(
  id: string | undefined,
  title: string,
  scope: 'shared' | 'private',
  notesDir: string,
): string {
  if (id !== undefined && id !== '') {
    const withExt = ensureMdExtension(id)
    if (!isSafeNoteId(withExt)) {
      throw new Error(`memory-curator: invalid note id ${JSON.stringify(withExt)}: ids must be vault-relative paths without '..', '.', backslashes, leading slashes, or drive letters`)
    }
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
 * Frontmatter for a capture that overwrites `id`. `wiki_write` overwrite
 * replaces the whole file, so the note's existing fields have to be carried
 * over here or an update silently drops whatever another writer recorded and
 * resets `created` to the update time.
 * Capture the note version before approval so any later change makes the
 * guarded write fail. Never treat a non-ENOENT read error as a missing note.
 * @param ctx - registrant context carrying the tool registry.
 * @param exec - the run context the nested read is dispatched under.
 * @param id - vault-relative note id about to be overwritten.
 * Existing frontmatter fields are preserved by the subsequent merge.
 * @returns the stored frontmatter and version for a guarded write.
 */
async function readFrontmatter(
  ctx: Context,
  exec: ToolRunContext,
  id: string,
): Promise<{ frontmatter: Record<string, unknown>; version: string } | undefined> {
  try {
    const note = await callTool<{ frontmatter?: unknown; version: string }>(ctx, exec, 'wiki_read', { id })
    return {
      frontmatter: note !== null && typeof note === 'object' && note.frontmatter !== null && typeof note.frontmatter === 'object'
        ? note.frontmatter as Record<string, unknown>
        : {},
      version: note.version,
    }
  } catch (error) {
    // Only a missing note means a first capture: `wiki_read` reports it as
    // "no such note". Any other failure (permission denied, a directory in the
    // way) must surface instead of silently turning an update into a replace.
    if ((error as Error).message.includes('no such note')) return undefined
    throw error
  }
}

interface ProvenanceFields {
  source_session?: string
  commit?: string
  verified?: boolean
}

function pickProvenance(args: Record<string, unknown>): ProvenanceFields {
  const picked: ProvenanceFields = {}
  if (typeof args.source_session === 'string' && args.source_session !== '') picked.source_session = args.source_session
  if (typeof args.commit === 'string' && args.commit !== '') picked.commit = args.commit
  if (typeof args.verified === 'boolean') picked.verified = args.verified
  return picked
}

function overwriteFrontmatter(
  existing: { frontmatter: Record<string, unknown>; version: string } | undefined,
  title: string,
  tags: string[],
  now: string,
  provenance: ProvenanceFields,
): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = { ...existing?.frontmatter, title, tags, ...provenance }
  const created = existing?.frontmatter.created
  frontmatter.created = typeof created === 'string' && created !== '' ? created : now
  if (existing !== undefined) frontmatter.updated = now
  return frontmatter
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
    description: 'Search the memory vault for prior notes related to the current task or topic. Call this at the start of a development task to avoid asking the user to repeat context that is already captured. Query terms are OR-matched and ranked by field-weighted relevance, so partial matches still return. Returns the matching note ids, titles, scores, and backlinks, plus total — how many notes matched before the result cap — and truncated, which is true when hits omits matches. A total above the returned hit count also means the list was truncated.',
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
      const search = await callTool<SearchPage>(ctx, exec, 'wiki_search', { query: args.query })
      // Mechanical per-turn summaries are useful for session replay, but they
      // are not curated knowledge. Keep them out of proactive recall unless a
      // caller explicitly searches the wiki. Two shapes exist under the notes
      // dir: the current subdir `auto-capture/<session>.md` and the legacy flat
      // `auto-capture-<session>.md`. A bare prefix or substring test would also
      // swallow unrelated notes that merely share the text, such as
      // `auto-capture-release-0.1.0-alpha.1.md`, so the flat form is matched by
      // the exact charset memory-anchor can emit.
      const notesPrefix = `${resolved.notesDir}/`
      const isAutoCapture = (id: string): boolean => {
        if (!id.startsWith(notesPrefix)) return false
        const rest = id.slice(notesPrefix.length)
        // The dir form is confined to the subdir, so any nested path is a capture.
        if (rest.startsWith('auto-capture/')) return true
        // memory-anchor's sessionNoteId sanitizes the session id to [A-Za-z0-9_-]+,
        // so a legacy flat capture never carries another dot in its file name;
        // `release-0.1.0-alpha.1` and other dot-bearing names stay in recall.
        return /^auto-capture-[A-Za-z0-9_-]+\.md$/.test(rest)
      }
      const curated = search.hits.filter(hit => !isAutoCapture(hit.id))
      // `search.total` is the vault-wide count before the search-layer cap. If
      // any auto-capture hits made it into the capped `hits` list, remove them
      // from the total so curated numbers stay truthful.
      const total = search.total - (search.hits.length - curated.length)
      ctx.logger?.debug(`memory-curator: recall query=${args.query} hits=${curated.length} total=${total}`)
      const hits = curated.slice(0, 20)
      return {
        query: args.query,
        hits,
        total,
        // `wiki_search` reports its own cap; recall caps again at 20, so the
        // page is incomplete whenever either cap bit.
        truncated: search.truncated || curated.length > hits.length,
      } as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_capture',
    description: 'Persist durable knowledge to the memory vault. Call this at the end of a significant task to capture decisions, discovered APIs, project conventions, fixes, or user preferences. It checks for conflicting notes, asks for approval when a conflict is found, and writes the captured note to the shared curated zone by default. Set requireExisting to replace an existing note with one current version without conflict approval; use mode: append only for genuinely additive material.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Short human-readable title for the knowledge entry. Used to derive the note id when id is omitted.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'The durable knowledge to record in concise Markdown. For a correction using requireExisting, provide the complete current conclusion, not only the changed fragment.',
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
        description: 'Use overwrite when the new summary supersedes an old conclusion; it replaces the whole body. Use append only for genuinely additive material: it adds a timestamped section and leaves the old text visible. Defaults to overwrite with requireExisting, otherwise append.',
      },
      conflictPolicy: {
        type: 'string',
        enum: ['ask', 'skip'],
        description: 'Override the deployment conflict policy for this capture: ask for approval on conflict, or skip the write.',
      },
      requireExisting: {
        type: 'boolean',
        description: 'Update-only capture: the note must exist and needs no conflict approval. Defaults to overwrite with a complete replacement summary; pass mode: append explicitly for additive material. A missing note fails instead of creating one.',
      },
      source_session: {
        type: 'string',
        description: 'Optional session id that produced this capture, stored in frontmatter for provenance.',
      },
      commit: {
        type: 'string',
        description: 'Optional upstream commit hash or reference this capture relates to, stored in frontmatter for provenance.',
      },
      verified: {
        type: 'boolean',
        description: 'Optional boolean marking the captured knowledge as verified, stored in frontmatter for provenance.',
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
      const requireExisting = args.requireExisting === true
      const explicitId = typeof args.id === 'string' && args.id !== ''
      const mode = args.mode ?? (requireExisting ? 'overwrite' : 'append')
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : []

      const [titleSearch, targetNote] = await Promise.all([
        callTool<SearchPage>(ctx, exec, 'wiki_search', { query: args.title, exactTitle: args.title }),
        readFrontmatter(ctx, exec, targetId),
      ])

      const targetHit: SearchHit[] = targetNote === undefined ? [] : [{ id: targetId, title: args.title, score: 0, backlinks: [] }]
      const conflicts = dedupeHits(findConflicts(targetId, args.title, [...targetHit, ...titleSearch.hits]))
      const conflictExists = conflicts.length > 0
      const finalId = requireExisting || explicitId || targetNote !== undefined ? targetId : conflicts[0]?.id ?? targetId
      if (!requireExisting && !explicitId && targetNote === undefined && (titleSearch.truncated || conflicts.length > 1)) {
        return {
          written: false,
          id: targetId,
          conflict: true,
          reason: 'ambiguous or truncated conflict search; provide the exact existing note id before writing',
        } as unknown as JsonValue
      }
      const selectedNote = finalId === targetId ? targetNote : await readFrontmatter(ctx, exec, finalId)
      const approvedVersion = selectedNote?.version

      // A declared update-only capture targets an existing note by
      // construction, so the approval that guards against accidentally
      // clobbering one while creating is not required; `wiki_write` enforces
      // the existence requirement itself, atomically with the write.
      if (conflictExists && !requireExisting) {
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
          reason: `memory_capture conflicts with existing note(s):\n${conflictList}\nProposed action: ${mode === 'append' ? 'append a new section (old text remains visible) to' : 'replace the entire body of'} "${finalId}".`,
          displayReason: {
            en: `Memory capture conflicts with existing note(s):\n${conflictList}\nAllow ${mode} to "${finalId}"? ${mode === 'append' ? 'Old conclusions remain visible.' : 'The old body is replaced.'}`,
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

      // A conflict suggests the note exists, but update-only writes use the
      // exact target id and ask the vault instead of relying on search ranking.
      // A missing note fails the write; other captures stay conflict-driven
      // and create new notes. Overwrites carry the read version to wiki_write
      // so an intervening change is refused rather than silently replaced.
      // Append remains available when the caller requests additive material.
      const exists = requireExisting ? targetNote !== undefined : conflictExists
      const appending = exists && mode === 'append'
      const writeMode: 'append' | 'overwrite' = appending ? 'append' : 'overwrite'
      const provenance = pickProvenance(args as Record<string, unknown>)
      ctx.logger?.debug(`memory-curator: capture target=${finalId} conflicts=${conflicts.length} writeMode=${writeMode} requireExisting=${requireExisting}`)
      const overwrite = appending ? undefined : overwriteFrontmatter(selectedNote, args.title, tags, now, provenance)
      const headingPrefix = args.summary.trimStart().startsWith('#') ? '' : `# ${args.title}\n\n`
      const content = appending
        ? appendContent
        : `---\n${yaml.dump(overwrite).trim()}\n---\n\n${headingPrefix}${appendContent}`

      const writeResult = await callTool<WriteResult>(ctx, exec, 'wiki_write', {
        id: finalId,
        content,
        mode: writeMode,
        baseVersion: approvedVersion ?? createHash('sha1').update('').digest('hex'),
        ...(requireExisting || (conflictExists && !explicitId) ? { requireExisting: true } : {}),
      })

      const response: Record<string, unknown> = {
        written: true,
        id: writeResult.id,
        mode: writeMode,
        // A declared update is not a conflict: the caller named the note it
        // meant to change, so nothing required approval or a skip decision.
        conflict: conflictExists && !requireExisting,
        version: writeResult.version,
      }
      if (typeof writeResult.created === 'string' && writeResult.created !== '') response.created = writeResult.created
      if (typeof writeResult.updated === 'string' && writeResult.updated !== '') response.updated = writeResult.updated
      if (typeof writeResult.committed === 'boolean') response.committed = writeResult.committed
      return response as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_correct',
    description: 'Replace one existing curated note with a single complete current conclusion. Read the note with wiki_read first, then provide its exact id and version as baseVersion. Refuses a missing or changed note; never appends or selects a note by title.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact vault-relative id returned by wiki_read; never inferred from a title.' },
      baseVersion: { type: 'string', required: true, description: 'Version from wiki_read. A concurrent change refuses the correction.' },
      summary: { type: 'string', required: true, description: 'Complete current conclusion in Markdown, replacing the old body.' },
      details: { type: 'string', description: 'Optional additional context included in the new current body.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional replacement tags; omitted tags retain existing tags.' },
      source_session: { type: 'string', description: 'Optional session id that produced this correction, stored in frontmatter for provenance.' },
      commit: { type: 'string', description: 'Optional upstream commit hash or reference this correction relates to, stored in frontmatter for provenance.' },
      verified: { type: 'boolean', description: 'Optional boolean marking the corrected knowledge as verified, stored in frontmatter for provenance.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!isSafeNoteId(args.id) || !args.id.endsWith('.md')) throw new Error('memory-curator: correction requires a safe vault-relative .md note id')
      const note = await callTool<{ frontmatter: Record<string, unknown>; body: string; version: string }>(ctx, exec, 'wiki_read', { id: args.id })
      if (note.version !== args.baseVersion) throw new Error(`memory-curator: note ${args.id} changed since it was read; re-read it before correcting`)
      const now = formatBeijingTime(new Date())
      const existing = note.frontmatter ?? {}
      const heading = /^#\s+(.+)$/m.exec(note.body)?.[1]
      const title = typeof existing.title === 'string' && existing.title !== '' ? existing.title : heading ?? args.id.replace(/\.md$/, '')
      const correctionProvenance = pickProvenance(args as Record<string, unknown>)
      const frontmatter: Record<string, unknown> = {
        ...existing,
        title,
        ...(args.tags !== undefined ? { tags: args.tags.map(String) } : {}),
        created: typeof existing.created === 'string' && existing.created !== '' ? existing.created : now,
        updated: now,
        ...correctionProvenance,
      }
      const details = args.details ? `\n\n## Details\n\n${args.details}` : ''
      const headingPrefix = args.summary.trimStart().startsWith('#') ? '' : `# ${title}\n\n`
      const content = `---\n${yaml.dump(frontmatter).trim()}\n---\n\n${headingPrefix}${args.summary}${details}\n`
      const written = await callTool<WriteResult>(ctx, exec, 'wiki_write', {
        id: args.id, content, mode: 'overwrite', requireExisting: true, baseVersion: args.baseVersion,
      })
      return {
        written: true, id: written.id, mode: 'overwrite', conflict: false, version: written.version,
        ...(written.created !== undefined ? { created: written.created } : {}),
        ...(written.updated !== undefined ? { updated: written.updated } : {}),
        ...(written.committed !== undefined ? { committed: written.committed } : {}),
      } as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_compact',
    description: 'Archive old per-turn auto-capture notes, keeping only the most recent sessions. This reduces search noise while preserving every capture in git history. Disabled by default; enable via autoCaptureCompact in the curator config. Returns { compacted, kept, archived, archivedIds } when active, or { compacted: false, reason } when disabled.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const compact = resolved.autoCaptureCompact
      if (!compact.enabled) {
        return { compacted: false, reason: 'auto-capture compaction is disabled in curator config' } as unknown as JsonValue
      }
      const keep = typeof compact.keepSessions === 'number' && compact.keepSessions >= 1 ? Math.floor(compact.keepSessions) : 0
      if (keep < 1) {
        return { compacted: false, reason: 'autoCaptureCompact.keepSessions must be >= 1' } as unknown as JsonValue
      }

      const notesPrefix = `${resolved.notesDir}/`
      const isAutoCapture = (id: string): boolean => {
        if (!id.startsWith(notesPrefix)) return false
        const rest = id.slice(notesPrefix.length)
        if (rest.startsWith('auto-capture/')) return true
        return /^auto-capture-[A-Za-z0-9_-]+\.md$/.test(rest)
      }

      const search = await callTool<SearchPage>(ctx, exec, 'wiki_search', { query: 'auto-capture', maxResults: 10000 })
      const captures = dedupeHits(search.hits.filter(hit => isAutoCapture(hit.id)))
        .sort((a, b) => b.id.localeCompare(a.id))

      if (captures.length <= keep) {
        return { compacted: true, kept: captures.length, archived: 0, archivedIds: [] } as unknown as JsonValue
      }

      const toArchive = captures.slice(keep)
      const archivedIds: string[] = []
      for (const hit of toArchive) {
        const note = await callTool<{ version: string }>(ctx, exec, 'wiki_read', { id: hit.id })
        const result = await callTool<ForgetResult>(ctx, exec, 'memory_forget', { id: hit.id, baseVersion: note.version })
        if (result.forgotten) archivedIds.push(result.id)
      }
      return {
        compacted: true,
        kept: keep,
        archived: archivedIds.length,
        archivedIds,
      } as unknown as JsonValue
    },
  })))
}
