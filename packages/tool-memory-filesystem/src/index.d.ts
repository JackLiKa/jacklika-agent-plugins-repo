/**
 * Model-facing wiki/memory tools over a local Markdown vault. The package
 * provides `wiki_read`, `wiki_search`, and `wiki_write` so an agent can treat a
 * directory of Markdown notes as long-term memory. Notes are plain files with
 * YAML frontmatter and Obsidian-style `[[link]]` references; the agent reads,
 * searches, and appends notes through the tool registry without touching core
 * packages.
 * @module @jacklika/dsh-tool-memory-filesystem
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Note, SearchResult } from './types.ts';
export type * from './types.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "tool-memory-filesystem";
/** Services required by the wiki/memory tool suite. */
export declare const inject: string[];
/** Plugin configuration. */
export interface Config {
    /**
     * Explicit vault root. When omitted, each tool call resolves the memory
     * directory under the calling session's workspace (`<cwd>/.dsh/memory/`).
     * A relative path is resolved against the session workspace.
     */
    vaultRoot?: string;
    /** File extensions to treat as notes. */
    extensions?: string[];
    /** Maximum depth to follow `[[link]]` references when reading a note. */
    maxLinkDepth?: number;
    /** Maximum number of search hits to return. */
    maxSearchResults?: number;
    /**
     * Descend into dot-directories while indexing. `.git`, `.obsidian`, and
     * `node_modules` are always excluded. Enable this when `vaultRoot` points at
     * a directory whose notes live under a hidden path such as `.dsh/memory/`.
     */
    indexHiddenDirs?: boolean;
}
/** Schemastery configuration for the filesystem memory tool consumer. */
export declare const Config: z<Config>;
/**
 * Compute the vault root for one tool call: an explicit `vaultRoot` wins,
 * resolved relative to the session workspace; otherwise the call gets
 * `<session cwd>/.dsh/memory/` so each workspace owns its notes.
 * @param vaultRoot - the configured root (`''` selects the per-workspace default).
 * @param exec - the current tool execution carrying the agent session.
 * @returns absolute vault root for this call.
 */
export declare function resolveMemoryVaultRoot(vaultRoot: string | undefined, exec: Pick<ToolRunContext, 'agent'>): string;
/**
 * Reject paths that escape the vault root. The check resolves the candidate,
 * normalizes `..`, and requires the result to start with the root path followed
 * by a path separator (or equal the root itself).
 * @param root - absolute vault root.
 * @param candidate - a relative or absolute path.
 * @returns the absolute, contained path.
 */
export declare function containedPath(root: string, candidate: string): string;
/**
 * Extract YAML frontmatter and body from Markdown text. Only the leading
 * `---\n...\n---\n` form is recognized.
 * @param text - raw file contents.
 * @returns frontmatter map and body.
 */
export declare function splitFrontmatter(text: string): {
    frontmatter: Record<string, unknown>;
    body: string;
};
/**
 * Fingerprint one note's raw file contents. The value lets `wiki_write`
 * detect that another writer changed the note since it was read.
 * @param text - raw file contents.
 * @returns content hash stable across processes.
 */
export declare function noteVersion(text: string): string;
/**
 * Find all Obsidian-style `[[link]]` references in note text. Aliases of the
 * form `[[link|alias]]` return the link target only.
 * @param text - note body.
 * @returns array of link targets.
 */
export declare function extractLinks(text: string): string[];
/**
 * Normalize a configured file extension to a dot-prefixed form.
 * @param ext - extension string.
 * @returns `.md` form.
 */
export declare function dottedExtension(ext: string): string;
/**
 * Resolve a link target to an existing note file inside the vault. The target
 * may omit the extension; extensions are tried in config order.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param target - link target from `[[...]]`.
 * @returns the resolved absolute path, or `undefined` if no file exists.
 */
export declare function resolveLinkTarget(root: string, extensions: string[], target: string): Promise<string | undefined>;
/**
 * Recursively discover note files under the vault root. `.git`, `.obsidian`,
 * and `node_modules` are always excluded; other dot-directories are skipped
 * unless `indexHiddenDirs` is enabled.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param indexHiddenDirs - descend into remaining dot-directories.
 * @returns absolute paths of every note file.
 */
export declare function listNotePaths(root: string, extensions: string[], indexHiddenDirs?: boolean): Promise<string[]>;
/** Wire view of one linked note, truncated to avoid deep recursion types. */
export interface LinkedNote {
    id: string;
    path: string;
    frontmatter: Record<string, unknown>;
    body: string;
    links: string[];
    version: string;
    linkedNotes: LinkedNote[];
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
export declare function readNote(root: string, extensions: string[], maxLinkDepth: number, absolutePath: string, visited?: ReadonlySet<string>): Promise<Note & {
    linkedNotes: LinkedNote[];
}>;
/**
 * Build a search index of note titles and backlinks. The title is the first
 * Markdown `# heading` or the basename without extension.
 * @param root - vault root.
 * @param extensions - note extensions.
 * @param indexHiddenDirs - descend into dot-directories besides the fixed exclusions.
 * @returns a map from note id to search result.
 */
export declare function buildIndex(root: string, extensions: string[], indexHiddenDirs?: boolean): Promise<Map<string, SearchResult>>;
/**
 * Register the `wiki_read`, `wiki_search`, and `wiki_write` tools on
 * `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit vault configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map