/**
 * Multi-layer lexical ranking for `wiki_search`: field-weighted BM25-style
 * scoring over note id/title/backlinks/body, a verbatim-phrase bonus, and a
 * link-graph boost for notes referenced by strong lexical hits. Substring
 * matching (not tokenization) keeps CJK text working without a segmenter.
 * @module @jacklika/dsh-tool-memory-filesystem/search
 */

import type { IndexedNote, SearchResult } from './types.ts'

/** A search hit carrying its fused relevance score. */
export interface RankedHit extends SearchResult {
  /** Relevance score: BM25 sum (+phrase/graph bonuses), or an RRF score when semantic fusion ran. */
  score: number
}

const K1 = 1.2
const B = 0.75
const TITLE_WEIGHT = 3
const BODY_WEIGHT = 1
const BACKLINK_WEIGHT = 1
const GRAPH_BOOST = 0.15
const RRF_K = 60

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let from = 0
  while ((from = haystack.indexOf(needle, from)) !== -1) {
    count += 1
    from += needle.length
  }
  return count
}

interface PreparedNote {
  note: IndexedNote
  titleField: string
  backlinkField: string
  bodyField: string
  docLen: number
}

function toHit(note: IndexedNote, score: number): RankedHit {
  return {
    id: note.id,
    title: note.title,
    score: Math.round(score * 10000) / 10000,
    backlinks: note.backlinks,
  }
}

/**
 * Rank every note in `index` against `query`. Any note containing at least one
 * query term (OR semantics) is a candidate; scores follow BM25 saturation with
 * field weights (`id`/`title` ×3, backlinks ×1, body ×1), a phrase bonus for a
 * verbatim multi-term match, and a graph boost for notes linked from a scored
 * hit.
 * @param index - note index built by {@link buildIndex}.
 * @param query - raw query text.
 * @returns hits sorted by descending score.
 */
export function rankNotes(index: Map<string, IndexedNote>, query: string): RankedHit[] {
  const lowered = query.toLowerCase()
  const terms = [...new Set(lowered.split(/\s+/).filter(Boolean))]
  if (terms.length === 0) return []
  const prepared: PreparedNote[] = [...index.values()].map(note => ({
    note,
    titleField: `${note.id} ${note.title}`.toLowerCase(),
    backlinkField: note.backlinks.join(' ').toLowerCase(),
    bodyField: note.body.toLowerCase(),
    docLen: Math.max(1, note.body.length),
  }))
  const docCount = prepared.length
  const avgdl = prepared.reduce((sum, p) => sum + p.docLen, 0) / Math.max(1, docCount)

  const idf = new Map<string, number>()
  for (const term of terms) {
    const df = prepared.filter(p =>
      p.titleField.includes(term) || p.backlinkField.includes(term) || p.bodyField.includes(term),
    ).length
    idf.set(term, Math.log(1 + (docCount - df + 0.5) / (df + 0.5)))
  }
  const sumIdf = [...idf.values()].reduce((a, b) => a + b, 0)

  const scores = new Map<string, number>()
  const phrase = lowered.trim()
  for (const p of prepared) {
    let score = 0
    for (const term of terms) {
      const tf =
        TITLE_WEIGHT * countOccurrences(p.titleField, term) +
        BACKLINK_WEIGHT * countOccurrences(p.backlinkField, term) +
        BODY_WEIGHT * countOccurrences(p.bodyField, term)
      if (tf === 0) continue
      const termIdf = idf.get(term) ?? 0
      score += termIdf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * p.docLen) / avgdl))
    }
    if (terms.length > 1) {
      if (p.titleField.includes(phrase)) score += sumIdf
      else if (p.bodyField.includes(phrase)) score += 0.5 * sumIdf
    }
    if (score > 0) scores.set(p.note.id, score)
  }

  // Graph boost: a note linked from a scored hit gains a fraction of that
  // hit's score (the strongest link wins). `backlinks` lists the sources, so
  // hit H links to T exactly when H.id ∈ T.backlinks.
  const linkedBoost = new Map<string, number>()
  for (const p of prepared) {
    for (const sourceId of p.note.backlinks) {
      const sourceScore = scores.get(sourceId)
      if (sourceScore !== undefined) {
        linkedBoost.set(p.note.id, Math.max(linkedBoost.get(p.note.id) ?? 0, GRAPH_BOOST * sourceScore))
      }
    }
  }

  const hits: RankedHit[] = []
  for (const p of prepared) {
    const score = (scores.get(p.note.id) ?? 0) + (linkedBoost.get(p.note.id) ?? 0)
    if (score > 0) hits.push(toHit(p.note, score))
  }
  hits.sort((a, b) => b.score - a.score || codeUnitCompare(a.id, b.id))
  return hits
}

/**
 * Locale-independent code-unit ordering — `localeCompare` without a locale
 * follows the host runtime locale, which makes tied-score ordering differ
 * across machines.
 */
export function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Fuse the lexical ranking with a semantic-search ranking using reciprocal
 * rank fusion (k = 60). Semantic-only notes are surfaced with their index
 * metadata so the output shape stays uniform.
 * @param lexical - hits from {@link rankNotes}.
 * @param semanticIds - note ids ordered by descending semantic similarity.
 * @param index - the note index for metadata lookup.
 * @returns fused hits sorted by descending RRF score.
 */
export function fuseRankings(
  lexical: RankedHit[],
  semanticIds: string[],
  index: Map<string, IndexedNote>,
): RankedHit[] {
  const fused = new Map<string, RankedHit>()
  const contribute = (id: string, rank: number): void => {
    const existing = fused.get(id)
    if (existing !== undefined) {
      existing.score += 1 / (RRF_K + rank + 1)
      return
    }
    const note = index.get(id)
    if (note === undefined) return // never fabricate a hit for an id outside the vault index
    fused.set(id, {
      id,
      title: note.title,
      score: 1 / (RRF_K + rank + 1),
      backlinks: note.backlinks,
    })
  }
  lexical.forEach((hit, rank) => contribute(hit.id, rank))
  semanticIds.forEach((id, rank) => contribute(id, rank))
  const hits = [...fused.values()]
  for (const hit of hits) hit.score = Math.round(hit.score * 10000) / 10000
  hits.sort((a, b) => b.score - a.score || codeUnitCompare(a.id, b.id))
  return hits
}
