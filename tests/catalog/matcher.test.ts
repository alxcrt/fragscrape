import { normalizeText, tokenize, identityTokens, searchPhrase } from '../../src/catalog/normalize';
import { scoreCandidate, editDistance } from '../../src/catalog/matcher';

const aventus = { brand: 'Creed', name: 'Aventus', votes: 8900 };
const aventusCologne = { brand: 'Creed', name: 'Aventus Cologne', votes: 1609 };
const br540Edp = { brand: 'Maison Francis Kurkdjian', name: 'Baccarat Rouge 540', variant: 'Eau de Parfum', votes: 5442 };
const br540Extrait = { brand: 'Maison Francis Kurkdjian', name: 'Baccarat Rouge 540', variant: 'Extrait de Parfum', votes: 3408 };
const baccante = { brand: 'Alkemia', name: 'Baccante', votes: 23 };

describe('normalize', () => {
  it('strips accents, punctuation and sizes', () => {
    expect(normalizeText('Le Mâle Élixir 125ml')).toBe('le male elixir');
    expect(normalizeText("L'Homme 3.4 fl oz")).toBe('lhomme');
  });

  it('treats N°5 and No 5 alike', () => {
    expect(normalizeText('Chanel N°5')).toBe(normalizeText('chanel no 5'));
    expect(normalizeText('No.5')).toBe('no 5');
  });

  it('expands concentration abbreviations', () => {
    expect(tokenize('Sauvage EDT')).toEqual(['sauvage', 'eau', 'de', 'toilette']);
  });

  it('builds live search phrases from the words as written', () => {
    expect(searchPhrase('CK One')).toBe('ck one');
    expect(searchPhrase('Not a Perfume')).toBe('not a perfume');
    expect(searchPhrase('CREED AVENTUS eau de parfum 100ml vaporisateur spray')).toBe('creed aventus');
    expect(searchPhrase('Sauvage EDT')).toBe('sauvage');
  });

  it('maps number words to digits', () => {
    expect(tokenize('One Million')).toEqual(['1', 'million']);
  });

  it('keeps weak name words for live lookups', () => {
    expect(identityTokens('Mon Paris')).toEqual(['mon', 'paris']);
    expect(identityTokens('Not a Perfume')).toEqual(['not', 'perfume']);
  });

  it('keeps only identity words for live lookups', () => {
    expect(identityTokens('CREED AVENTUS eau de parfum 100ml vaporisateur spray')).toEqual(['creed', 'aventus']);
  });
});

describe('editDistance', () => {
  it('counts transpositions as one edit', () => {
    expect(editDistance('aventus', 'avnetus')).toBe(1);
    expect(editDistance('sauvage', 'suavage')).toBe(1);
  });
});

describe('scoreCandidate', () => {
  it('ranks prefix suggestions with popularity', () => {
    const q = 'bacc';
    expect(scoreCandidate(q, br540Edp, 'autocomplete')).toBeGreaterThan(scoreCandidate(q, baccante, 'autocomplete'));
  });

  it('matches partial last words while typing', () => {
    expect(scoreCandidate('creed av', aventus, 'autocomplete')).toBeGreaterThan(0.8);
  });

  it('matches noisy label text with a typo', () => {
    const text = 'CREED AVNETUS eau de parfum 100ml vaporisateur spray';
    expect(scoreCandidate(text, aventus, 'match')).toBeGreaterThan(0.8);
    expect(scoreCandidate(text, aventus, 'match')).toBeGreaterThan(scoreCandidate(text, aventusCologne, 'match'));
  });

  it('picks the right variant from label text', () => {
    const text = 'MAISON FRANCIS KURKDJIAN PARIS BACCARAT ROUGE 540 EXTRAIT DE PARFUM 70ml';
    expect(scoreCandidate(text, br540Extrait, 'match')).toBeGreaterThan(scoreCandidate(text, br540Edp, 'match'));
  });

  it('handles words merged by OCR', () => {
    expect(scoreCandidate('maison francis kurkdjian baccaratrouge 540', br540Edp, 'match')).toBeGreaterThan(0.75);
  });

  it('prefers names containing weak words when they were typed', () => {
    const monParis = { brand: 'Yves Saint Laurent', name: 'Mon Paris', votes: 2000 };
    const monGuerlain = { brand: 'Guerlain', name: 'Mon Guerlain', votes: 3000 };
    expect(scoreCandidate('mon paris', monParis, 'autocomplete')).toBeGreaterThan(scoreCandidate('mon paris', monGuerlain, 'autocomplete'));
    expect(scoreCandidate('one million paco', { brand: 'Rabanne', name: '1 Million', votes: 5000 }, 'match')).toBeGreaterThan(0.55);
  });

  it('gives unrelated text a low score', () => {
    expect(scoreCandidate('asdkjh qwerty', aventus, 'match')).toBeLessThan(0.3);
  });
});
