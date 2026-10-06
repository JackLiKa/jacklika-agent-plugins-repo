import { describe, expect, it } from 'vitest'
import { createLinkResolver, extractLinks } from '../src/index.ts'

const IDS = [
  'shared/notes/todo-anchor-session-isolation-and-schema-guard.md',
  'shared/notes/wiki-search-or-scoring.md',
  'concepts/RAG.md',
  'embedding.md',
  'alpha/dup.md',
  'beta/deep/dup.md',
]

const resolve = createLinkResolver(IDS)

describe('createLinkResolver (Obsidian-style link resolution)', () => {
  it('resolves exact vault-relative paths with or without extension', () => {
    expect(resolve('concepts/RAG')).toBe('concepts/RAG.md')
    expect(resolve('concepts/RAG.md')).toBe('concepts/RAG.md')
  })

  it('resolves bare basenames nested under directories', () => {
    expect(resolve('wiki-search-or-scoring')).toBe('shared/notes/wiki-search-or-scoring.md')
    expect(resolve('todo-anchor-session-isolation-and-schema-guard'))
      .toBe('shared/notes/todo-anchor-session-isolation-and-schema-guard.md')
  })

  it('resolves path-suffix matches', () => {
    expect(resolve('notes/wiki-search-or-scoring')).toBe('shared/notes/wiki-search-or-scoring.md')
    expect(resolve('deep/dup')).toBe('beta/deep/dup.md')
  })

  it('prefers the fewest path segments on basename ambiguity, then code-unit order', () => {
    // 'dup' basename matches alpha/dup.md (2 segments) and beta/deep/dup.md (3) —
    // the shorter path wins.
    expect(resolve('dup')).toBe('alpha/dup.md')
  })

  it('breaks segment ties by code-unit order, deterministically', () => {
    const ties = createLinkResolver(['b/x.md', 'a/x.md'])
    expect(ties('x')).toBe('a/x.md')
  })

  it('returns undefined for unresolvable or code-literal links', () => {
    expect(resolve('link')).toBeUndefined()
    expect(resolve('no-such-note')).toBeUndefined()
  })

  it('tolerates the target carrying the extension at the basename tier', () => {
    expect(resolve('wiki-search-or-scoring.md')).toBe('shared/notes/wiki-search-or-scoring.md')
  })

  it('matches the naive three-tier scan on a large vault (1000 notes, 500 targets)', () => {
    const ids: string[] = []
    for (let i = 0; i < 250; i++) {
      ids.push(`d${i % 7}/notes/note-${i}.md`)
      ids.push(`shared/n${i % 5}/note-${i}.md`)
      ids.push(`deep/d${i % 3}/d${i % 2}/dup-${i % 20}.md`)
      ids.push(`root-${i}.md`)
    }
    const naive = (t: string): string | undefined => {
      const pick = (matches: string[]): string | undefined =>
        matches.sort(
          (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0),
        )[0]
      const stem = (id: string) => id.replace(/\.[^./]+$/, '')
      return pick(ids.filter(id => id === t || stem(id) === t))
        ?? pick(ids.filter(id => id.endsWith(`/${t}`) || stem(id).endsWith(`/${t}`)))
        ?? pick(ids.filter(id => {
          const b = id.slice(id.lastIndexOf('/') + 1)
          return b === t || b.replace(/\.[^./]+$/, '') === t
        }))
    }
    const fast = createLinkResolver(ids)
    for (let i = 0; i < 500; i++) {
      const targets = [
        `note-${i % 250}`,
        `root-${i % 250}`,
        `d${i % 7}/notes/note-${i % 250}`,
        `notes/note-${i % 250}`,
        `dup-${i % 20}`,
        `missing-${i}`,
      ]
      for (const t of targets) expect(fast(t)).toBe(naive(t))
    }
  })
})

describe('extractLinks (code-literal filtering)', () => {
  it('ignores [[...]] inside inline code spans and fenced code blocks', () => {
    const text = [
      'See [[real-link]] and [[another|alias]].',
      'Inline `[[fake-inline]]` documents the syntax.',
      'Double `` `[[fake-double]]` `` span too.',
      '```md',
      'A fenced [[fake-fenced]] example.',
      '```',
      '~~~',
      'Also [[fake-tilde]] fenced.',
      '~~~',
      'Trailing [[real-tail]] works.',
    ].join('\n')
    expect(extractLinks(text)).toEqual(['real-link', 'another', 'real-tail'])
  })

  it('ignores an unclosed fence to end of note', () => {
    const text = 'Intro [[real]] then\n```\n[[fake-unclosed]]\n'
    expect(extractLinks(text)).toEqual(['real'])
  })

  it('does not let an unmatched backtick run eat the next span opener', () => {
    // The real-vault failure: an isolated ``` run inside one span, followed by
    // a normal `[[link]]` span. The lazy regex let the ``` run pair with the
    // later span opener at length 1, exposing the literal.
    const text = [
      'Fences `(``` / ~~~)` behave per CommonMark, and literal `[[link]]` shows the syntax.',
      'Related: [[real-a]], [[real-b]].',
    ].join('\n')
    expect(extractLinks(text)).toEqual(['real-a', 'real-b'])
  })

  it('pairs a lone backtick run only with the next equal-length run', () => {
    // CommonMark: the first run opens a span closed by the second, so
    // ' stray then ' is code but [[fake]] outside it is a real link; the
    // third run is unmatched and literal.
    const text = 'a ` stray then `[[fake]]` span then [[real]]'
    expect(extractLinks(text)).toEqual(['fake', 'real'])
  })

  it('closes a fence at a longer run of the same marker', () => {
    const text = '[[real-before]]\n```\n[[fake]]\n````\n[[real-after]]'
    expect(extractLinks(text)).toEqual(['real-before', 'real-after'])
  })

  it('does not close a fence at a shorter run of the same marker', () => {
    const text = '````\n[[fake]]\n```\n[[fake-still-inside]]'
    expect(extractLinks(text)).toEqual([])
  })

  it('does not let a tilde fence close a backtick fence', () => {
    const text = '```\n[[fake]]\n~~~\n[[fake-still-inside]]'
    expect(extractLinks(text)).toEqual([])
  })

  it('honours indented fences and trailing space on the closing line', () => {
    const text = '  ```\n[[fake]]\n   ```  \n[[real]]'
    expect(extractLinks(text)).toEqual(['real'])
  })
})
