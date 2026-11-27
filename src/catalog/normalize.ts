/**
 * Text normalisation and token weighting shared by indexing and matching.
 */

/** Words that carry no identity (packaging, filler). */
const STOPWORDS = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'the', 'by', 'and', 'of', 'a', 'an', 'pour', 'for', 'et', 'en',
  'spray', 'vaporisateur', 'vaporizer', 'vapo', 'natural', 'naturel', 'ml', 'oz', 'fl', 'new', 'tester', 'paris',
  'perfume', 'fragrance', 'parfums',
]);

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
    tokens.push(...(ABBREVIATIONS[token] ?? [token]));
  }
  return tokens;
}

export function tokenWeight(token: string): number {
  if (STOPWORDS.has(token)) return 0;
  if (VARIANT_WORDS.has(token)) return 0.3;
  return 1;
}

/** Tokens worth sending to a live search (identity words only). */
export function identityTokens(input: string): string[] {
  return tokenize(input).filter((t) => tokenWeight(t) === 1);
}
