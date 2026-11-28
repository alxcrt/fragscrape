import sharp from 'sharp';
import database from '../database/database';
import logger from '../utils/logger';
import parfumoScraper from '../scrapers/parfumoScraper';
import { NotFoundError } from '../api/middleware/errorHandler';
import type { Perfume } from '../types';
import * as catalog from './catalog';
import { whiteBorderRatio, refineMatte, withAlpha } from './imageProcess';
import { maskNeedsRefine } from './imageAi';
import { matteInWorker } from './imageWorkerClient';
import type { CatalogRow } from './catalog';
import { scoreCandidate, MatchMode } from './matcher';
import { identityTokens, normalizeText, searchPhrase } from './normalize';
import {
  ListingItem, searchSource, rankingSource, brandSource, parseSimilar, parseDetailExtras, fetchHtml,
  perfumeUrl, imagePathFromSrc, imageUrl, mediaKeyFromSrc,
} from './source';

/** The public shape of a perfume in lists. */
export interface Item {
  id: number;
  name: string;
  brand: string;
  variant?: string;
  year?: number;
  gender?: string;
  image?: string;
  rating?: number;
  votes?: number;
}

export function toItem(row: CatalogRow, baseUrl: string): Item {
  const item: Item = { id: row.id, name: row.name, brand: row.brand };
  if (row.variant) item.variant = row.variant;
  if (row.year) item.year = row.year;
  if (row.gender) item.gender = row.gender;
  // Pending images get their own URL, so clients fetch the cut-out once it is ready
  if (row.image) item.image = `${baseUrl}/images/${row.id}.webp?v=${IMAGE_VERSION}${catalog.hasFinalImage(row.id, 240) ? '' : '&pending=1'}`;
  if (row.rating) item.rating = row.rating;
  if (row.votes) item.votes = row.votes;
  return item;
}

interface Ranked { row: CatalogRow; score: number }

function rankLocal(query: string, mode: MatchMode, limit: number): Ranked[] {
  const threshold = mode === 'autocomplete' ? 0.4 : 0.45;
  return catalog.candidates(query)
    .map((row) => ({ row, score: scoreCandidate(query, row, mode) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score || (b.row.votes ?? 0) - (a.row.votes ?? 0))
    .slice(0, limit);
}

const inflight = new Map<string, Promise<number>>();

/** Look a phrase up at the source once, add every result to the catalog. */
async function liveLookup(phrase: string): Promise<number> {
  const key = normalizeText(phrase);
  if (key.length < 2 || catalog.recentlyQueried(key)) return 0;
  const running = inflight.get(key);
  if (running) return running;
  const task = (async () => {
    try {
      const items = await searchSource(key);
      catalog.upsertItems(items);
      catalog.markQueried(key, items.length);
      return items.length;
    } catch (err) {
      logger.warn(`Live lookup failed for "${key}": ${(err as Error).message}`);
      return 0;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/** Suggestions while typing. Answers from the local catalog; goes live only when it has too little. */
export async function autocomplete(q: string, limit: number): Promise<Ranked[]> {
  let ranked = rankLocal(q, 'autocomplete', limit);
  const words = identityTokens(q);
  const phrase = searchPhrase(q);
  if (phrase.length < 3 || words.length === 0) return ranked;

  const lookup = async () => {
    const found = await liveLookup(phrase);
    // The source matches whole phrases only; retry with the longest word
    if (found === 0 && words.length > 1) {
      const longest = [...words].sort((a, b) => b.length - a.length)[0];
      if (longest.length >= 4) await liveLookup(longest);
    }
  };

  if (ranked.length >= limit && ranked[0].score >= 0.75) {
    // Good enough now: enrich the catalog in the background for the next keystroke
    void lookup();
    return ranked;
  }
  await lookup();
  ranked = rankLocal(q, 'autocomplete', limit);
  return ranked;
}

/** Best match for noisy text such as a label read from a photo. */
export async function match(text: string, limit: number): Promise<Ranked[]> {
  // Below this, look the text up live too: quality first, the extra lookups take ~0.2 s each
  const good = 0.9;
  let ranked = rankLocal(text, 'match', limit);
  if (ranked[0]?.score >= good) {
    warm(ranked[0].row.id);
    return ranked;
  }

  const words = identityTokens(text).slice(0, 8);
  const attempts: string[] = [];
  const phrase = searchPhrase(text);
  if (phrase) attempts.push(phrase);
  if (words.length > 0) attempts.push(words.join(' '));
  for (let i = 0; i + 1 < words.length && attempts.length < 5; i++) attempts.push(`${words[i]} ${words[i + 1]}`);
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    if (w.length >= 4 && attempts.length < 7) attempts.push(w);
  }

  for (const phrase of [...new Set(attempts)]) {
    await liveLookup(phrase);
    ranked = rankLocal(text, 'match', limit);
    if (ranked[0]?.score >= good) break;
  }
  warm(ranked[0]?.row.id);
  return ranked;
}

export interface Detail extends Item {
  imageLarge?: string;
  concentration?: string;
  description?: string;
  perfumer?: string;
  notes?: { top: string[]; heart: string[]; base: string[] };
  accords?: string[];
  longevity?: number;
  sillage?: number;
  bottle?: number;
  value?: number;
  rank?: { position: number; category?: string };
  status?: string;
  similar: Array<Item & { similarity?: number }>;
}

const DETAIL_FRESH_SECONDS = 24 * 60 * 60;
const refreshing = new Set<number>();

/** Resolve the source path of a catalog row (rows from "similar" strips have none yet). */
async function resolvePath(row: CatalogRow): Promise<string> {
  if (row.path) return row.path;
  const items = await searchSource(`${row.name} ${row.brand}`);
  catalog.upsertItems(items);
  const hit = items.find((i) => (row.media_key && i.mediaKey === row.media_key)
    || (normalizeText(i.name) === normalizeText(row.name) && normalizeText(i.brand) === normalizeText(row.brand)
      && normalizeText(i.variant ?? '') === normalizeText(row.variant ?? '')));
  if (!hit?.path) throw new NotFoundError(`Details for perfume ${row.id}`);
  return hit.path;
}

/** Fetch and store a detail page: perfume data, similar list, refreshed catalog row. */
async function fetchDetail(row: CatalogRow): Promise<Perfume> {
  const path = await resolvePath(row);
  const url = perfumeUrl(path);
  const html = await fetchHtml(url, 'aggregateRating');
  if (!html) throw new NotFoundError(`Perfume ${row.id}`);
  const perfume = parfumoScraper.parseDetailsHtml(html, url);
  const extras = parseDetailExtras(html);
  perfume.perfumer = perfume.perfumer || extras.perfumer;
  perfume.description = perfume.description || extras.description;
  database.savePerfume(perfume);
  const sims = parseSimilar(html);
  const simRows = catalog.upsertItems(sims);
  catalog.setSimilar(row.id, simRows.map((r, i) => ({ id: r.id, ...(sims[i]?.similarity !== undefined ? { similarity: sims[i].similarity } : {}) })));
  catalog.upsertItem({
    path, mediaKey: row.path ? mediaKeyFromSrc(perfume.imageUrl) : row.media_key, image: imagePathFromSrc(perfume.imageUrl),
    name: row.name, brand: row.brand, variant: row.variant, year: perfume.year ?? row.year,
    gender: perfume.gender ?? row.gender, rating: perfume.rating ?? row.rating, votes: perfume.totalRatings ?? row.votes,
  } as ListingItem);
  return perfume;
}

function refreshInBackground(row: CatalogRow): void {
  if (refreshing.has(row.id)) return;
  refreshing.add(row.id);
  fetchDetail(row)
    .catch((err) => logger.warn(`Background refresh of ${row.id} failed: ${(err as Error).message}`))
    .finally(() => refreshing.delete(row.id));
}

/** Fetch details ahead of time so the next request is instant. */
function warm(id: number | undefined): void {
  if (!id) return;
  const row = catalog.getById(id);
  if (!row) return;
  const cached = row.path ? database.getPerfumeByUrlAnyAge(perfumeUrl(row.path)) : null;
  if (!cached || cached.ageSeconds > DETAIL_FRESH_SECONDS || !catalog.getSimilar(id)) refreshInBackground(row);
}

/** Full details for a catalog id: served from storage, refreshed in the background when old. */
export async function detail(id: number, baseUrl: string): Promise<Detail> {
  let row = catalog.getById(id);
  if (!row) throw new NotFoundError(`Perfume ${id}`);

  const cached = row.path ? database.getPerfumeByUrlAnyAge(perfumeUrl(row.path)) : null;
  let perfume: Perfume;
  if (cached && catalog.getSimilar(id)) {
    perfume = cached.perfume;
    if (cached.ageSeconds > DETAIL_FRESH_SECONDS) refreshInBackground(row);
  } else {
    perfume = await fetchDetail(row);
    row = catalog.getById(id)!;
  }

  const out: Detail = { ...toItem(row, baseUrl), similar: [] };
  if (row.image) out.imageLarge = `${baseUrl}/images/${row.id}.webp?size=large&v=${IMAGE_VERSION}${catalog.hasFinalImage(row.id, 720) ? '' : '&pending=1'}`;
  if (perfume.concentration) out.concentration = perfume.concentration;
  if (perfume.description) out.description = perfume.description;
  if (perfume.perfumer) out.perfumer = perfume.perfumer;
  if (perfume.notes && (perfume.notes.top?.length || perfume.notes.heart?.length || perfume.notes.base?.length)) {
    out.notes = { top: perfume.notes.top ?? [], heart: perfume.notes.heart ?? [], base: perfume.notes.base ?? [] };
  }
  if (perfume.accords?.length) out.accords = perfume.accords;
  if (perfume.longevity) out.longevity = perfume.longevity;
  if (perfume.sillage) out.sillage = perfume.sillage;
  if (perfume.bottleRating) out.bottle = perfume.bottleRating;
  if (perfume.priceValue) out.value = perfume.priceValue;
  if (perfume.rank) out.rank = { position: perfume.rank, ...(perfume.rankCategory ? { category: perfume.rankCategory } : {}) };
  if (perfume.productionStatus && perfume.productionStatus !== 'unknown') out.status = perfume.productionStatus;
  out.similar = (catalog.getSimilar(id) ?? []).flatMap(({ id: sid, similarity }) => {
    const r = catalog.getById(sid);
    return r ? [{ ...toItem(r, baseUrl), ...(similarity !== undefined ? { similarity } : {}) }] : [];
  });
  return out;
}

const LIST_FRESH_SECONDS = 12 * 60 * 60;
const listRefreshing = new Set<string>();

/** Lists (brands, rankings): stored permanently, refreshed in the background when old. */
async function cachedList(key: string, load: () => Promise<ListingItem[]>): Promise<CatalogRow[]> {
  const refresh = async () => {
    const rows = catalog.upsertItems(await load());
    if (rows.length > 0) catalog.setList(key, rows.map((r) => r.id));
    return rows;
  };
  const hit = catalog.getList(key);
  if (hit && hit.ids.length > 0) {
    if (hit.ageSeconds > LIST_FRESH_SECONDS && !listRefreshing.has(key)) {
      listRefreshing.add(key);
      refresh().catch((err) => logger.warn(`List refresh ${key} failed: ${(err as Error).message}`))
        .finally(() => listRefreshing.delete(key));
    }
    return hit.ids.map((i) => catalog.getById(i)!).filter(Boolean);
  }
  return refresh();
}

export function brand(name: string, page: number): Promise<CatalogRow[]> {
  return cachedList(`brand:${normalizeText(name)}:${page}`, () => brandSource(name, page));
}

export function rankings(category: string, page: number, production: string, edition: string): Promise<CatalogRow[]> {
  return cachedList(`rank:${category}:${page}:${production}:${edition}`, () => rankingSource(category, page, production, edition));
}

export const IMAGE_SIZES = { small: 240, large: 720 } as const;
export type ImageSize = keyof typeof IMAGE_SIZES;
export interface ImageResult { body: Buffer; type: string; final: boolean }

const originals = new Map<number, Promise<Buffer | null>>();

/** Download the full-size source image once (shared by the quick and AI paths). */
function original(id: number): Promise<Buffer | null> {
  let task = originals.get(id);
  if (!task) {
    task = (async () => {
      const row = catalog.getById(id);
      if (!row?.image) return null;
      const res = await fetch(imageUrl(row.image, 1200), { signal: AbortSignal.timeout(15000) });
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
      return Buffer.from(await res.arrayBuffer());
    })();
    originals.set(id, task);
    setTimeout(() => originals.delete(id), 120000);
  }
  return task;
}

/** Bump to make clients and caches fetch freshly rendered images. */
export const IMAGE_VERSION = 5;

/**
 * Cut out the product with the AI model and encode both sizes as WebP.
 * Returns null when a white-background image could not be cut out (no model).
 */
async function renderImage(source: Buffer): Promise<Record<ImageSize, Buffer> | null> {
  const max = IMAGE_SIZES.large;
  const { data, info } = await sharp(source)
    .resize(max, max, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let rgba = data;
  // Only studio shots on a white background get cut out; others are kept as they are
  if (whiteBorderRatio(data, info.width, info.height) >= 0.5) {
    const alpha = await matteInWorker(source, info.width, info.height);
    if (!alpha) return null;
    rgba = withAlpha(data, maskNeedsRefine() ? refineMatte(alpha, info.width, info.height, data) : alpha);
  }
  return encode(rgba, info.width, info.height);
}

async function encode(rgba: Buffer, width: number, height: number): Promise<Record<ImageSize, Buffer>> {
  const out = {} as Record<ImageSize, Buffer>;
  for (const [name, w] of Object.entries(IMAGE_SIZES) as Array<[ImageSize, number]>) {
    out[name] = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .resize(w, w, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85, alphaQuality: 95, effort: 5 })
      .toBuffer();
  }
  return out;
}

const PRIORITY = { viewed: 2, prefetch: 1 } as const;
let draining = false;

/** Queue the background removal for an image (persisted, survives restarts). */
function enqueueImage(id: number, priority: keyof typeof PRIORITY): void {
  if (catalog.hasFinalImage(id, IMAGE_SIZES.small)) return;
  catalog.enqueueImageJob(id, PRIORITY[priority]);
  void drainImages();
}

/** Process queued images one at a time in the low-priority worker. */
export async function drainImages(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let id = catalog.nextImageJob(); id !== null; id = catalog.nextImageJob()) {
      try {
        if (catalog.hasFinalImage(id, IMAGE_SIZES.small)) {
          catalog.finishImageJob(id);
          continue;
        }
        const source = await original(id);
        if (!source) {
          catalog.finishImageJob(id);
          continue;
        }
        const rendered = await renderImage(source);
        if (!rendered) {
          catalog.failImageJob(id);
          continue;
        }
        for (const [name, w] of Object.entries(IMAGE_SIZES) as Array<[ImageSize, number]>) {
          catalog.setImage(id, w, 'image/webp', rendered[name]);
        }
        catalog.finishImageJob(id);
      } catch (err) {
        logger.warn(`Image ${id} failed: ${(err as Error).message}`);
        catalog.failImageJob(id);
      }
    }
  } finally {
    draining = false;
  }
}

/** Queue images for items about to be shown, behind images people are viewing. */
export function prefetchImages(ids: number[]): void {
  for (const id of ids) enqueueImage(id, 'prefetch');
}

/**
 * Image for a catalog id, never waiting for the model: the final cut-out when it
 * is stored, otherwise the plain product photo (and the cut-out is queued).
 */
export async function image(id: number, size: ImageSize): Promise<ImageResult | null> {
  const width = IMAGE_SIZES[size];
  const stored = catalog.getImage(id, width);
  if (stored) return { body: stored.data, type: stored.type, final: true };
  const row = catalog.getById(id);
  if (!row?.image) return null;

  enqueueImage(id, 'viewed');
  const plain = catalog.getPlainImage(id, width);
  if (plain) return { body: plain, type: 'image/webp', final: false };
  const source = await original(id);
  if (!source) return null;
  const { data, info } = await sharp(source)
    .resize(IMAGE_SIZES.large, IMAGE_SIZES.large, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const encoded = await encode(data, info.width, info.height);
  for (const [name, w] of Object.entries(IMAGE_SIZES) as Array<[ImageSize, number]>) catalog.setPlainImage(id, w, encoded[name]);
  return { body: encoded[size], type: 'image/webp', final: false };
}

/** Fill an empty catalog with the most popular perfumes, slowly, in the background. */
export async function seed(): Promise<void> {
  void drainImages();
  if (catalog.count() >= 300) return;
  for (const category of ['unisex', 'mens', 'womens']) {
    for (let page = 1; page <= 5; page++) {
      try {
        await rankings(category, page, 'all', 'all');
      } catch (err) {
        logger.warn(`Seeding ${category} page ${page} failed: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  logger.info(`Catalog seeded: ${catalog.count()} perfumes`);
}
