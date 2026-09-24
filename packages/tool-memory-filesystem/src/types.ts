/**
 * Shared types for filesystem-backed wiki/memory notes.
 * @module @jacklika/dsh-tool-memory-filesystem/types
 */

/** Parsed frontmatter and body of one Markdown note. */
export interface Note {
  /** Absolute path to the source file. */
  path: string
  /** Relative path inside the vault, used as a stable note id. */
  id: string
  /** YAML frontmatter key/value map. */
  frontmatter: Record<string, unknown>
  /** Note body after frontmatter. */
  body: string
  /** Obsidian-style `[[target]]` links found in the body. */
  links: string[]
  /**
   * Content fingerprint of the raw file at read time. Pass it back as
   * `baseVersion` in `wiki_write` to fail when another writer changed the
   * note in between.
   */
  version: string
}

/** Result of a search across the vault. */
export interface SearchResult {
  /** Note id (relative path). */
  id: string
  /** Note title: first heading, or the basename without extension. */
  title: string
  /** Paths of notes that link to this note. */
  backlinks: string[]
}
