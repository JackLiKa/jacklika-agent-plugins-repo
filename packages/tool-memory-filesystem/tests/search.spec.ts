import { describe, expect, it } from 'vitest'
import { fuseRankings, rankNotes, type RankedHit } from '../src/search.ts'
import type { IndexedNote } from '../src/types.ts'

function note(id: string, title: string, body: string, backlinks: string[] = []): IndexedNote {
  return { id, title, body, backlinks }
}

describe('rankNotes / fuseRankings', () => {
  it('fuseRankings drops ids that are not in the vault index', () => {
    const index = new Map<string, IndexedNote>([
      ['a.md', note('a.md', 'Alpha', 'content about retrieval')],
    ])
    const lexical: RankedHit[] = [{ id: 'a.md', title: 'Alpha', score: 2, backlinks: [] }]
    const fused = fuseRankings(lexical, ['a.md', 'https://evil.example/foreign.md'], index)
    expect(fused.map(h => h.id)).toEqual(['a.md'])
  })

  it('semantic fusion lifts a semantic-only vault note into the results', () => {
    const index = new Map<string, IndexedNote>([
      ['a.md', note('a.md', 'Alpha', 'lexical match body')],
      ['b.md', note('b.md', 'Beta', 'no keyword match')],
    ])
    const lexical = rankNotes(index, 'lexical')
    expect(lexical.map(h => h.id)).toEqual(['a.md'])
    const fused = fuseRankings(lexical, ['b.md', 'a.md'], index)
    expect(fused.map(h => h.id)).toContain('b.md')
    const beta = fused.find(h => h.id === 'b.md')
    expect(beta?.title).toBe('Beta')
  })
})
