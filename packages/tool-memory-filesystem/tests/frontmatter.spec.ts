import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from '@jacklika/dsh-tool-memory-filesystem'

describe('splitFrontmatter', () => {
  it('parses CRLF notes written by external editors', () => {
    const text = '---\r\ntitle: Obsidian note\r\ntags:\r\n  - alpha\r\n  - beta\r\n---\r\n\r\nBody line.\r\n'
    const { frontmatter, body } = splitFrontmatter(text)
    expect(frontmatter.title).toBe('Obsidian note')
    expect(frontmatter.tags).toEqual(['alpha', 'beta'])
    expect(body.includes('Body line.')).toBe(true)
  })

  it('keeps unquoted timestamps in the +08:00 convention', () => {
    const text = '---\ncreated: 2026-01-01T00:00:00+08:00\n---\nBody.\n'
    const { frontmatter } = splitFrontmatter(text)
    expect(frontmatter.created).toBe('2026-01-01T00:00:00+08:00')
  })

  it('returns quoted timestamps verbatim', () => {
    const text = "---\ncreated: '2026-01-01T00:00:00+08:00'\n---\nBody.\n"
    const { frontmatter } = splitFrontmatter(text)
    expect(frontmatter.created).toBe('2026-01-01T00:00:00+08:00')
  })

  it('returns the raw text when frontmatter markers are absent', () => {
    const text = 'no frontmatter\n'
    expect(splitFrontmatter(text)).toEqual({ frontmatter: {}, body: text })
  })
})
