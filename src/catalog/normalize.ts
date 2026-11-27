/**
 * Text normalisation and token weighting shared by indexing and matching.
 */

/** Words that carry no identity (packaging, filler). */
const STOPWORDS = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'the', 'by', 'and', 'of', 'a', 'an', 'pour', 'for', 'et', 'en',
  'spray', 'vaporisateur', 'vaporizer', 'vapo', 'natural', 'naturel', 'ml', 'oz', 'fl', 'tester',
]);

/** Common on labels but also part of real names ("Mon Paris", "Not a Perfume"): low weight, still searched. */
const WEAK_WORDS = new Set([
  'paris', 'london', 'new', 'york', 'perfume', 'perfumes', 'fragrance', 'parfums', 'homme', 'femme', 'men', 'women',
  'man', 'woman', 'him', 'her',
]);

/** Number words as digits, so "One Million" matches "1 Million". */
const NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

/** Concentration/variant words: useful to pick a variant, weak for identity. */
const VARIANT_WORDS = new Set([
  'eau', 'parfum', 'toilette', 'cologne', 'extrait', 'edp', 'edt', 'edc', 'elixir', 'absolu', 'concentree',
  'concentre', 'intense', 'hair', 'mist', 'brume', 'cheveux', 'body', 'lotion', 'oil', 'deodorant', 'aftershave',
  'after', 'shave', 'limited', 'edition', 'collector',
]);

const ABBREVIATIONS: Record<string, string[]> = {
  edp: ['eau', 'de', 'parfum'],
  edt: ['eau', 'de', 'toilette'],
  edc: ['eau', 'de', 'cologne'],
};

/** Lowercase, strip accents and punctuation; keep letters, digits and single spaces. */
export function normalizeText(input: string): string {
  return input
    // "N°5", "Nº 5", "No.5" all become "no 5"
    .replace(/\bn\s*[°º]\s*/gi, 'no ')
    .replace(/\bno\.\s*(?=\d)/gi, 'no ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    // Sizes such as 100ml, 3.4 fl oz, 50 ML are packaging, not identity
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|mls|oz|fl\.?\s*oz|cl|g)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  const tokens: string[] = [];
  for (const token of normalized.split(' ')) {
    tokens.push(...(ABBREVIATIONS[token] ?? [NUMBERS[token] ?? token]));
  }
  return tokens;
}

export function tokenWeight(token: string): number {
  if (STOPWORDS.has(token)) return 0;
  if (VARIANT_WORDS.has(token) || WEAK_WORDS.has(token)) return 0.3;
  return 1;
}

/** Tokens worth sending to a live search: identity words plus weak name words, no packaging or concentration. */
export function identityTokens(input: string): string[] {
  return tokenize(input).filter((t) => tokenWeight(t) === 1 || WEAK_WORDS.has(t));
}

const PACKAGING = new Set(['spray', 'vaporisateur', 'vaporizer', 'vapo', 'natural', 'naturel', 'ml', 'oz', 'fl', 'tester', 'edp', 'edt', 'edc']);

/**
 * Phrase for a live search: the words as written (no digit mapping, small words
 * kept, so "Not a Perfume" and "CK One" search well), minus sizes, packaging and
 * concentration phrases that make exact-phrase search fail.
 */
export function searchPhrase(input: string): string {
  return normalizeText(input)
    .replace(/\b(?:eau de (?:parfum|toilette|cologne)|extrait de parfum|eau fraiche|parfum intense)\b/g, ' ')
    .split(' ')
    .filter((w) => w && !PACKAGING.has(w))
    .join(' ');
}
