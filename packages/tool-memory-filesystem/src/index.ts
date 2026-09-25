/**
 * Model-facing wiki/memory tools over a local Markdown vault. The package
 * provides `wiki_read`, `wiki_search`, and `wiki_write` so an agent can treat a
 * directory of Markdown notes as long-term memory. Notes are plain files with
 * YAML frontmatter and Obsidian-style `[[link]]` references; the agent reads,
 * searches, and appends notes through the tool registry without touching core
 * packages.
 * @module @jacklika/dsh-tool-memory-filesystem
 */

import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import yaml from 'js-yaml'
import type { Note, SearchResult } from './types.ts'

export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory-filesystem'

/** Services required by the wiki/memory tool suite. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /**
   * Explicit vault root. When omitted, each tool call resolves the memory
   * directory under the calling session's workspace (`<cwd>/.dsh/memory/`).
   * A relative path is resolved against the session workspace.
   */
  vaultRoot?: string
  /** File extensions to treat as notes. */
  extensions?: string[]
  /** Maximum depth to follow `[[link]]` references when reading a note. */
  maxLinkDepth?: number
  /** Maximum number of search hits to return. */
  maxSearchResults?: number
  /**
   * Descend into dot-directories while indexing. `.git`, `.obsidian`, and
   * `node_modules` are always excluded. Enable this when `vaultRoot` points at
   * a directory whose notes live under a hidden path such as `.dsh/memory/`.
   */
  indexHiddenDirs?: boolean
}

/** Schemastery configuration for the filesystem memory tool consumer. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().default(''),
  extensions: z.array(z.string()).default(['.md']),
  maxLinkDepth: z.number().default(1),
  maxSearchResults: z.number().default(20),
  indexHiddenDirs: z.boolean().default(false),
})

/** The shape after schemastery applied the defaults; `vaultRoot` is `''` when unset. */
type ResolvedConfig = Required<Config>

/**
 * Compute the vault root for one tool call: an explicit `vaultRoot` wins,
 * resolved relative to the session workspace; otherwise the call gets
 * `<session cwd>/.dsh/memory/` so each workspace owns its notes.
 * @param vaultRoot - the configured root (`''` selects the per-workspace default).
 * @param exec - the current tool execution carrying the agent session.
 * @returns absolute vault root for this call.
 */
export function resolveMemoryVaultRoot(
  vaultRoot: string | undefined,
  exec: Pick<ToolRunContext, 'agent'>,
): string {
  const sessionCwd = exec.agent?.session.header.cwd ?? process.cwd()
  if (vaultRoot === undefined || vaultRoot === '') {
    return join(sessionCwd, '.dsh', 'memory')
  }
  return isAbsolute(vaultRoot) ? vaultRoot : resolve(sessionCwd, vaultRoot)
}

/**
 * Reject paths that escape the vault root. The check resolves the candidate,
 * normalizes `..`, and requires the result to start with the root path followed
 * by a path separator (or equal the root itself).
 * @param root - absolute vault root.
 * @param candidate - a relative or absolute path.
 * @returns the absolute, contained path.
 */
export function containedPath(root: string, candidate: string): string {
  const absoluteRoot = resolve(root)
  const absolute = resolve(absoluteRoot, candidate)
  const remainder = relative(absoluteRoot, absolute)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`tool-memory-filesystem: path ${candidate} is outside vault root ${root}`)
  }
  return absolute
}

/**
 * Resolve a vault path and reject an existing symlink or junction component
 * whose real target leaves the vault. The nearest existing ancestor protects
 * paths whose final file or directories do not exist yet.
 * @param root - vault root; it must exist.
 * @param candidate - vault-relative path.
 * @returns the absolute lexical path after realpath containment succeeds.
 */
export async function containedPathReal(root: string, candidate: string): Promise<string> {
  const absolute = containedPath(root, candidate)
  const canonicalRoot = await realpath(resolve(root))
  let ancestor = absolute
  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor)
      const remainder = relative(canonicalRoot, canonicalAncestor)
      if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
        throw new Error(`tool-memory-filesystem: path ${candidate} resolves outside vault root ${root}`)
      }
      return absolute
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
}

/**
 * Extract YAML frontmatter and body from Markdown text. Only the leading
 * `---\n...\n---\n` form is recognized.
 * @param text - raw file contents.
 * @returns frontmatter map and body.
 */
export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (match === null) {
    return { frontmatter: {}, body: text }
  }
  const frontmatterText = match[1] ?? ''
  const bodyText = match[2] ?? ''
  try {
    const parsed = yaml.load(frontmatterText)
    return {
      frontmatter: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {},
      body: bodyText,
    }
  } catch {
    return { frontmatter: {}, body: text }
  }
}

/**
 * Fingerprint one note's raw file contents. The value lets `wiki_write`
 * detect that another writer changed the note since it was read.
 * @param text - raw file contents.
 * @returns content hash stable across processes.
 */
export function noteVersion(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * Find all Obsidian-style `[[link]]` references in note text. Aliases of the
 * form `[[link|alias]]` return the link target only.
 * @param text - note body.
 * @returns array of link targets.
 */
export function extractLinks(text: string): string[] {
  const links: string[] = []
  const pattern = /\[\[([^|\]\r\n]+)(?:\|[^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) links.push(match[1].trim())
  }
  return [...new Set(links)]
}

/**
 * Normalize a configured file extension to a dot-prefixed form.
 * @param ext - extension string.
 * @returns `.md` form.
 */
export function dottedExtension(ext: string): string {
  return ext.startsWith('.') ? ext : `.${ext}`
}

/**
 * Resolve a link target to an existing note file inside the vault. The target
 * may omit the extension; extensions are tried in config order.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param target - link target from `[[...]]`.
 * @returns the resolved absolute path, or `undefined` if no file exists.
 */
export async function resolveLinkTarget(
  root: string,
  extensions: string[],
  target: string,
): Promise<string | undefined> {
  const candidates = extensions.map(ext => `${target}${dottedExtension(ext)}`)
  candidates.push(target)
  for (const candidate of candidates) {
    try {
      const path = await containedPathReal(root, candidate)
      const info = await stat(path)
      if (info.isFile()) return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

/**
 * Recursively discover note files under the vault root. `.git`, `.obsidian`,
 * and `node_modules` are always excluded; other dot-directories are skipped
 * unless `indexHiddenDirs` is enabled.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param indexHiddenDirs - descend into remaining dot-directories.
 * @returns absolute paths of every note file.
 */
export async function listNotePaths(
  root: string,
  extensions: string[],
  indexHiddenDirs = false,
): Promise<string[]> {
  const results: string[] = []
  const exclude = new Set(['.git', 'node_modules', '.obsidian'])

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!indexHiddenDirs && entry.name.startsWith('.') && entry.name !== '.') continue
      if (exclude.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(dottedExtension(ext)))) {
        results.push(full)
      }
    }
  }

  await walk(root)
  return results
}

/** Wire view of one linked note, truncated to avoid deep recursion types. */
export interface LinkedNote {
  id: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
  links: string[]
  version: string
  linkedNotes: LinkedNote[]
}

/**
 * Read and parse one Markdown note, following configured link depth.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param maxLinkDepth - how many link hops to resolve.
 * @param absolutePath - absolute path of the note.
 * @param visited - set of already-visited absolute paths to prevent cycles.
 * @returns the parsed note with linked notes attached.
 */
export async function readNote(
  root: string,
  extensions: string[],
  maxLinkDepth: number,
  absolutePath: string,
  visited: ReadonlySet<string> = new Set(),
): Promise<Note & { linkedNotes: LinkedNote[] }> {
  if (visited.has(absolutePath)) {
    return {
      path: absolutePath,
      id: relative(root, absolutePath),
      frontmatter: {},
      body: '',
      links: [],
      version: '',
      linkedNotes: [],
    }
  }
  const nextVisited = new Set(visited)
  nextVisited.add(absolutePath)
  const text = await readFile(absolutePath, 'utf8')
  const { frontmatter, body } = splitFrontmatter(text)
  const links = extractLinks(text)
  const linkedNotes: LinkedNote[] = []
  if (maxLinkDepth > 0) {
    for (const link of links) {
      const target = await resolveLinkTarget(root, extensions, link)
      if (target !== undefined) {
        const child = await readNote(root, extensions, maxLinkDepth - 1, target, nextVisited)
        linkedNotes.push(child)
      }
    }
  }
  return {
    path: absolutePath,
    id: relative(root, absolutePath),
    frontmatter,
    body,
    links,
    version: noteVersion(text),
    linkedNotes,
  }
}

/**
 * Build a search index of note titles and backlinks. The title is the first
 * Markdown `# heading` or the basename without extension.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param indexHiddenDirs - descend into dot-directories besides the fixed exclusions.
 * @returns a map from note id to search result.
 */
export async function buildIndex(
  root: string,
  extensions: string[],
  indexHiddenDirs = false,
): Promise<Map<string, SearchResult>> {
  const paths = await listNotePaths(root, extensions, indexHiddenDirs)
  const notes: Note[] = []
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    const { frontmatter, body } = splitFrontmatter(text)
    notes.push({
      path,
      id: relative(root, path),
      frontmatter,
      body,
      links: extractLinks(text),
      version: noteVersion(text),
    })
  }
  const index = new Map<string, SearchResult>()
  for (const note of notes) {
    const headingMatch = /^#\s+(.+)$/m.exec(note.body)
    const title = headingMatch !== null && headingMatch[1] !== undefined
      ? headingMatch[1].trim()
      : note.id.replace(/\.[^.]+$/, '')
    index.set(note.id, { id: note.id, title, backlinks: [] })
  }
  for (const note of notes) {
    for (const link of note.links) {
      const targetId = [...index.keys()].find((id) => {
        const base = id.replace(/\.[^.]+$/, '')
        return base === link || id === link
      })
      if (targetId !== undefined) {
        const entry = index.get(targetId)
        if (entry !== undefined && !entry.backlinks.includes(note.id)) {
          entry.backlinks.push(note.id)
        }
      }
    }
  }
  return index
}

/**
 * Write `contents` to `absolutePath` atomically: stage into a sibling temp
 * file, then `rename` over the target so concurrent readers never observe a
 * partially written note.
 * @param absolutePath - final note path inside the vault.
 * @param contents - complete file body to publish.
 */
async function writeAtomic(absolutePath: string, contents: string): Promise<void> {
  const tmpPath = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(tmpPath, contents, 'utf8')
    await rename(tmpPath, absolutePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Validate a positive-integer config bound. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-memory-filesystem: ${name} must be a positive integer`)
  }
}

/**
 * Register the `wiki_read`, `wiki_search`, and `wiki_write` tools on
 * `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit vault configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxLinkDepth', resolved.maxLinkDepth)
  assertPositiveInteger('maxSearchResults', resolved.maxSearchResults)

  const vaultRootFor = (exec: ToolRunContext): string => resolveMemoryVaultRoot(resolved.vaultRoot, exec)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_read',
    description: 'Read one Markdown note from the wiki vault, optionally following Obsidian-style [[link]] references up to the configured depth. Returns the note id, frontmatter, body, and linked notes.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Vault-relative path of the note to read (e.g. "concepts/RAG.md" or "daily/2026-09-23").',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const absolutePath = await containedPathReal(vaultRoot, args.id)
      const note = await readNote(vaultRoot, resolved.extensions, resolved.maxLinkDepth, absolutePath)
      return note as unknown as JsonValue
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_search',
    description: 'Search the wiki vault by note title or body keyword. Returns matching note ids, titles, and backlink counts. Use this before asking the user which note to read.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keyword or phrase to match against note titles and bodies.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            backlinks: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const index = await buildIndex(vaultRoot, resolved.extensions, resolved.indexHiddenDirs)
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean)
      const hits: SearchResult[] = []
      for (const result of index.values()) {
        const haystack = `${result.id} ${result.title} ${result.backlinks.join(' ')}`.toLowerCase()
        if (terms.every(term => haystack.includes(term))) {
          hits.push(result)
        }
      }
      hits.sort((a, b) => b.backlinks.length - a.backlinks.length)
      return hits.slice(0, resolved.maxSearchResults)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wiki_write',
    description: 'Create a new note or append to an existing note in the wiki vault. The path is relative to the vault root. When appending, the new content is inserted at the end of the body after a timestamp header.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Vault-relative path of the note (e.g. "meetings/2026-09-23.md").',
      },
      content: {
        type: 'string',
        required: true,
        description: 'Markdown content to write or append.',
      },
      mode: {
        type: 'string',
        description: 'Either "append" (default) or "overwrite".',
        enum: ['append', 'overwrite'],
      },
      baseVersion: {
        type: 'string',
        description: 'Optional version returned by wiki_read. When provided, the write fails if the note changed since that read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          mode: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const vaultRoot = vaultRootFor(exec)
      const mode = args.mode ?? 'append'
      await mkdir(vaultRoot, { recursive: true })
      const absolutePath = await containedPathReal(vaultRoot, args.id)
      const hasExtension = resolved.extensions.some(ext => args.id.endsWith(dottedExtension(ext)))
      if (!hasExtension) {
        throw new Error(`tool-memory-filesystem: note id must end with one of ${resolved.extensions.join(', ')}`)
      }
      await mkdir(dirname(absolutePath), { recursive: true })
      await containedPathReal(vaultRoot, args.id)
      exec.signal.throwIfAborted()
      let existing: string | undefined
      try {
        existing = await readFile(absolutePath, 'utf8')
      } catch {
        // file does not exist yet
      }
      if (args.baseVersion !== undefined && noteVersion(existing ?? '') !== args.baseVersion) {
        throw new Error(`tool-memory-filesystem: note ${args.id} changed since it was read; re-read it before writing`)
      }
      let finalBody: string
      if (mode === 'overwrite') {
        finalBody = args.content
      } else {
        const { frontmatter, body } = splitFrontmatter(existing ?? '')
        const frontmatterText = Object.keys(frontmatter).length > 0
          ? `---\n${yaml.dump(frontmatter).trim()}\n---\n\n`
          : ''
        const timestamp = new Date().toISOString()
        finalBody = `${frontmatterText}${body}\n\n## ${timestamp}\n\n${args.content}\n`
      }
      exec.signal.throwIfAborted()
      await writeAtomic(absolutePath, finalBody)
      return { id: relative(vaultRoot, absolutePath), mode, bytes: Buffer.byteLength(finalBody, 'utf8') }
    },
  })))
}
