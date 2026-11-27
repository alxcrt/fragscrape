import { tokenize, tokenWeight } from './normalize';

export type MatchMode = 'autocomplete' | 'match';

export interface Candidate {
  brand: string;
  name: string;
  variant?: string | null;
  votes?: number | null;
}

/** Damerau-Levenshtein (optimal string alignment) distance, bounded for speed. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

/** Similarity of one query token to one candidate token, 0..1. */
export function tokenSimilarity(q: string, c: string, allowPrefix: boolean): number {
  if (q === c) return 1;
  if (allowPrefix && q.length >= 1 && c.startsWith(q)) return 0.95;
  if (q.length >= 4 && c.length >= 4) {
    const d = editDistance(q, c, 2);
    if (d <= 1) return 0.85;
    if (d === 2 && Math.min(q.length, c.length) >= 7) return 0.75;
    // Typo in the part typed so far, e.g. "avnet" for "aventus"
    if (allowPrefix && c.length > q.length && editDistance(q, c.slice(0, q.length), 1) <= 1) return 0.8;
  }
  return 0;
}

/**
 * Score a candidate against free text, 0..1.
 * autocomplete: the query is a prefix being typed (the last word may be partial).
 * match: the query is noisy text such as a label read from a photo; extra words are tolerated.
 */
export function scoreCandidate(query: string, candidate: Candidate, mode: MatchMode): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;
  const brandTokens = tokenize(candidate.brand);
  const nameTokens = tokenize(`${candidate.name} ${candidate.variant ?? ''}`);
  const cTokens = [...brandTokens, ...nameTokens];
  if (cTokens.length === 0) return 0;

  // Words merged or split by OCR, e.g. "baccaratrouge" or "aven tus"
  const qJoined = qTokens.join('');
  const best = (c: string): number => {
    let s = 0;
    qTokens.forEach((q, i) => {
      const prefix = mode === 'autocomplete' && (i === qTokens.length - 1 || q.length >= 3);
      s = Math.max(s, tokenSimilarity(q, c, prefix));
    });
    if (s < 0.85 && c.length >= 5 && qJoined.includes(c)) s = Math.max(s, 0.85);
    return s;
  };

  let cWeight = 0, cScore = 0;
  const cBest = cTokens.map((c) => best(c));
  cTokens.forEach((c, i) => {
    const w = tokenWeight(c);
    cWeight += w;
    cScore += w * cBest[i];
  });
  const candidateCoverage = cWeight > 0 ? cScore / cWeight : 0;

  let qWeight = 0, qScore = 0;
  qTokens.forEach((q, i) => {
    const w = tokenWeight(q);
    if (w === 0) return;
    const prefix = mode === 'autocomplete' && (i === qTokens.length - 1 || q.length >= 3);
    let s = 0;
    for (const c of cTokens) s = Math.max(s, tokenSimilarity(q, c, prefix));
    if (s === 0 && q.length >= 5 && cTokens.join('').includes(q)) s = 0.85;
    qWeight += w;
    qScore += w * s;
  });
  const queryCoverage = qWeight > 0 ? qScore / qWeight : 0;

  const brandMatched = brandTokens.length > 0 && brandTokens.every((b) => tokenWeight(b) === 0 || best(b) >= 0.75);

  // Typing: every typed word must match, the rest of the name may still be missing.
  // Label text: the perfume's own words must all be present; extra label words are noise.
  const base = mode === 'autocomplete'
    ? 0.9 * queryCoverage + 0.1 * candidateCoverage
    : 0.7 * candidateCoverage + 0.3 * queryCoverage;
  const brand = brandMatched && candidateCoverage > 0.5 ? 1 : 0;
  // Popularity: strong for suggestions while typing, only a tie-breaker for matching
  const popularity = Math.min(Math.log10((candidate.votes ?? 0) + 1), 4) / 4;
  const score = mode === 'autocomplete'
    ? 0.78 * base + 0.06 * brand + 0.16 * popularity
    : 0.9 * base + 0.08 * brand + 0.02 * popularity;
  return Math.min(1, Math.round(score * 1000) / 1000);
}
