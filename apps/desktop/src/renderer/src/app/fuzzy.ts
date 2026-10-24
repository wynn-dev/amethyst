/**
 * Small fuzzy matcher for the command palette. A query matches when its characters appear in
 * order in the text. Scores favour prefix matches, word starts and consecutive runs, so "nwi"
 * ranks "New Instance" above "Show in Finder". Case-insensitive. No dependencies.
 */

export interface FuzzyMatch {
  score: number
  /** Indices of matched characters in the text, for highlighting. */
  indices: number[]
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true
  const prev = text[i - 1]!
  const cur = text[i]!
  return /[\s\-_.›/:(]/.test(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase())
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, indices: [] }
  const t = text.toLowerCase()

  // Fast path: a contiguous substring is always the best kind of match.
  const sub = t.indexOf(q)
  if (sub >= 0) {
    const indices = Array.from({ length: q.length }, (_, k) => sub + k)
    const score = 100 + q.length * 10 + (sub === 0 ? 50 : isBoundary(text, sub) ? 25 : 0) - sub * 0.5 - (t.length - q.length) * 0.1
    return { score, indices }
  }

  // Greedy subsequence that prefers word-boundary characters.
  const indices: number[] = []
  let score = 0
  let ti = 0
  let run = 0
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!
    if (c === ' ') continue
    // Look ahead for a boundary occurrence of c before taking the first occurrence.
    let pick = -1
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== c) continue
      if (pick < 0) pick = j
      if (isBoundary(text, j)) {
        // Only jump to a boundary if it doesn't break a consecutive run.
        if (!(run > 0 && pick === ti)) pick = j
        break
      }
    }
    if (pick < 0) return null
    const consecutive = indices.length > 0 && pick === indices[indices.length - 1]! + 1
    run = consecutive ? run + 1 : 0
    score += 1 + (consecutive ? 4 + run : 0) + (isBoundary(text, pick) ? 8 : 0) - Math.min(4, (pick - ti) * 0.2)
    indices.push(pick)
    ti = pick + 1
  }
  return { score: score - t.length * 0.05, indices }
}

export interface Ranked<T> {
  item: T
  match: FuzzyMatch
}

/** Filters and sorts items by their best-matching field (title first, then keywords). */
export function rank<T>(items: readonly T[], query: string, fields: (item: T) => string[]): Ranked<T>[] {
  const out: Ranked<T>[] = []
  for (const item of items) {
    const [title = '', ...rest] = fields(item)
    let best = fuzzyMatch(query, title)
    for (const k of rest) {
      const m = fuzzyMatch(query, k)
      // Keyword matches rank slightly below title matches and don't highlight the title.
      if (m && (!best || m.score - 15 > best.score)) best = { score: m.score - 15, indices: [] }
    }
    if (best) out.push({ item, match: best })
  }
  return out.toSorted((a, b) => b.match.score - a.match.score)
}
