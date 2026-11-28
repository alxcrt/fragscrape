import sharp from 'sharp';
import database from '../database/database';
import logger from '../utils/logger';
import parfumoScraper from '../scrapers/parfumoScraper';
import { NotFoundError } from '../api/middleware/errorHandler';
import type { Perfume } from '../types';
import * as catalog from './catalog';
import { whiteBorderRatio, refineMatte, withAlpha } from './imageProcess';
import { sealGlass } from './glassSeal';
import { maskNeedsRefine, modelId } from './imageAi';
import { matteInWorker } from './imageWorkerClient';
import type { CatalogRow } from './catalog';
import { scoreCandidate, MatchMode } from './matcher';
import { identityTokens, normalizeText, searchPhrase } from './normalize';
import {
  ListingItem, searchSource, rankingSource, brandSource, parseSimilar, parseDetailExtras, fetchHtml,
  perfumeUrl, imagePathFromSrc, imageUrl, mediaKeyFromSrc,
} from './source';

export type ImageStatus = 'ready' | 'pending' | 'none';

/** The public shape of a perfume in lists. */
export interface Item {
  id: number;
  name: string;
  brand: string;
  variant?: string;
  year?: number;
  gender?: string;
  image?: string;
  imageStatus: ImageStatus;
  imageVersion: number;
  /** Opaque area of the cut-out as fractions of the image (ready images only) */
  imageBounds?: catalog.ImageBounds;
  /** When the final image was rendered (ready images only) */
  imageUpdatedAt?: string;
  rating?: number;
  votes?: number;
}

/** Split a trailing "(2011)" disambiguation out of a name. */
export function cleanName(name: string, year: number | null): { name: string; year: number | null } {
  const m = name.match(/^(.*\S)\s*\(((?:19|20)\d{2})\)$/);
  if (!m) return { name, year };
  return { name: m[1], year: year ?? parseInt(m[2], 10) };
}

export function imageStatus(row: CatalogRow): ImageStatus {
  if (!row.image) return 'none';
  return catalog.hasFinalImage(row.id, IMAGE_SIZES.small) ? 'ready' : 'pending';
}

function renderEpoch(renderedAt: string | undefined): number | null {
  return renderedAt ? Math.floor(Date.parse(renderedAt.replace(' ', 'T') + 'Z') / 1000) : null;
}

export function imageLink(row: CatalogRow, baseUrl: string, size: ImageSize, status = imageStatus(row), renderedAt?: string): string {
  const sizeParam = size === 'small' ? '' : `size=${size}&`;
  // Pending images get their own URL, so clients fetch the cut-out once it is ready.
  // Final URLs carry the render time: a re-render always gets a new URL, so no cache keeps an old copy.
  const t = status === 'ready' ? renderEpoch(renderedAt ?? catalog.getImageMeta(row.id)?.renderedAt) : null;
  return `${baseUrl}/images/${row.id}.webp?${sizeParam}v=${IMAGE_VERSION}${status === 'pending' ? '&pending=1' : ''}${t ? `&t=${t}` : ''}`;
}

export function toItem(row: CatalogRow, baseUrl: string): Item {
  const { name, year } = cleanName(row.name, row.year);
  const status = imageStatus(row);
  const item: Item = { id: row.id, name, brand: row.brand, imageStatus: status, imageVersion: IMAGE_VERSION };
  if (row.variant) item.variant = row.variant;
  if (year) item.year = year;
  if (row.gender) item.gender = row.gender;
  const meta = status === 'ready' ? catalog.getImageMeta(row.id) : null;
  if (status !== 'none') item.image = imageLink(row, baseUrl, 'small', status, meta?.renderedAt);
  if (meta?.bounds) item.imageBounds = meta.bounds;
  if (meta?.renderedAt) item.imageUpdatedAt = new Date(meta.renderedAt.replace(' ', 'T') + 'Z').toISOString();
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
export async function autocomplete(q: string, limit: number, brand?: string): Promise<Ranked[]> {
  const brandKey = brand ? normalizeText(brand) : '';
  // With a brand filter, rank a wider pool and keep that brand's perfumes
  const rank = () => {
    const pool = rankLocal(brand ? `${q} ${brand}` : q, 'autocomplete', brand ? limit * 6 : limit);
    return (brandKey ? pool.filter((r) => normalizeText(r.row.brand).includes(brandKey)) : pool).slice(0, limit);
  };
  let ranked = rank();
  const words = identityTokens(brand ? `${brand} ${q}` : q);
  const phrase = searchPhrase(brand ? `${brand} ${q}` : q);
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
  ranked = rank();
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
  imageXl?: string;
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
  if (row.image) {
    out.imageLarge = imageLink(row, baseUrl, 'large', out.imageStatus);
    out.imageXl = imageLink(row, baseUrl, 'xl', out.imageStatus);
  }
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

export const IMAGE_SIZES = { small: 240, large: 720, xl: 1440 } as const;
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
export const IMAGE_VERSION = 7;

/**
 * Cut out the product with the AI model and encode both sizes as WebP.
 * Returns null when a white-background image could not be cut out (no model).
 */
async function renderImage(source: Buffer): Promise<{ sizes: Record<ImageSize, Buffer>; bounds: catalog.ImageBounds | null } | null> {
  const max = IMAGE_SIZES.xl;
  const { data, info } = await sharp(source)
    .resize(max, max, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let rgba = data;
  // BRIA handles any background; the lighter models only cut out white studio shots
  if (!maskNeedsRefine() || whiteBorderRatio(data, info.width, info.height) >= 0.5) {
    const alpha = await matteInWorker(source, info.width, info.height);
    if (!alpha) return null;
    rgba = withAlpha(data, maskNeedsRefine() ? refineMatte(alpha, info.width, info.height, data) : sealGlass(alpha, info.width, info.height, data));
  }
  return { sizes: await encode(rgba, info.width, info.height), bounds: opaqueBounds(rgba, info.width, info.height) };
}

/** Bounding box of pixels with alpha >= 32, as fractions of the image. */
export function opaqueBounds(rgba: Buffer, width: number, height: number): catalog.ImageBounds | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= 32) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x: r(minX / width), y: r(minY / height), w: r((maxX - minX + 1) / width), h: r((maxY - minY + 1) / height) };
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

const PRIORITY = { viewed: 2, prefetch: 1, upgrade: 0 } as const;

/**
 * Identifies how a cut-out was made: the model plus the post-processing applied to its mask.
 * Stored cut-outs made another way get re-rendered.
 */
function renderId(): string {
  return maskNeedsRefine() ? modelId() : `${modelId()}+glass`;
}

/** A stored cut-out made by a different model or recipe (e.g. the retired INT8 build): re-render it. */
function outdated(id: number): boolean {
  const meta = catalog.getImageMeta(id);
  return !!meta && meta.model !== renderId();
}
let draining = false;

/** Queue the background removal for an image (persisted, survives restarts). */
function enqueueImage(id: number, priority: keyof typeof PRIORITY): void {
  if (catalog.hasFinalImage(id, IMAGE_SIZES.small) && !outdated(id)) return;
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
        if (catalog.hasFinalImage(id, IMAGE_SIZES.small) && !outdated(id)) {
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
          catalog.setImage(id, w, 'image/webp', rendered.sizes[name]);
        }
        catalog.setImageMeta(id, rendered.bounds, renderId());
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

/**
 * One-time cleanup: images stored before every background was cut out (grey or
 * coloured studio backgrounds) have no transparency; drop them so they re-render.
 */
export async function purgeUncutImages(): Promise<number> {
  let purged = 0;
  for (const id of catalog.finalImageIds(IMAGE_SIZES.small)) {
    const img = catalog.getImage(id, IMAGE_SIZES.small);
    if (!img) continue;
    const { channels, isOpaque } = await sharp(img.data).stats();
    if (isOpaque || (channels[3] && channels[3].min === 255)) {
      catalog.deleteFinalImages(id);
      purged++;
    }
  }
  if (purged) logger.info(`Re-rendering ${purged} images that kept their background`);
  return purged;
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
  if (stored) {
    // Keep serving an older model's cut-out, but move its re-render up the queue
    if (outdated(id)) enqueueImage(id, 'viewed');
    return { body: stored.data, type: stored.type, final: true };
  }
  const row = catalog.getById(id);
  if (!row?.image) return null;

  // Rendered before the xl size existed: build it from the original and the stored cut-out's mask
  if (size === 'xl' && catalog.hasFinalImage(id, IMAGE_SIZES.large)) {
    const xl = await xlFromStoredMask(id);
    if (xl) return { body: xl, type: 'image/webp', final: true };
  }

  enqueueImage(id, 'viewed');
  const plain = catalog.getPlainImage(id, width);
  if (plain) return { body: plain, type: 'image/webp', final: false };
  const source = await original(id);
  if (!source) return null;
  const { data, info } = await sharp(source)
    .resize(IMAGE_SIZES.xl, IMAGE_SIZES.xl, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const encoded = await encode(data, info.width, info.height);
  for (const [name, w] of Object.entries(IMAGE_SIZES) as Array<[ImageSize, number]>) catalog.setPlainImage(id, w, encoded[name]);
  return { body: encoded[size], type: 'image/webp', final: false };
}

async function xlFromStoredMask(id: number): Promise<Buffer | null> {
  const large = catalog.getImage(id, IMAGE_SIZES.large);
  const source = await original(id);
  if (!large || !source) return null;
  const { data, info } = await sharp(source)
    .resize(IMAGE_SIZES.xl, IMAGE_SIZES.xl, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(large.data).ensureAlpha().extractChannel(3)
    .resize(info.width, info.height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  const body = await sharp(withAlpha(data, alpha), { raw: { width: info.width, height: info.height, channels: 4 } })
    .webp({ quality: 85, alphaQuality: 95, effort: 5 }).toBuffer();
  catalog.setImage(id, IMAGE_SIZES.xl, 'image/webp', body);
  return body;
}

/** Measure opaque bounds for images rendered before bounds were recorded. */
export async function backfillImageMeta(): Promise<void> {
  for (const id of catalog.finalImageIdsWithoutMeta(IMAGE_SIZES.large)) {
    const img = catalog.getImage(id, IMAGE_SIZES.large);
    if (!img) continue;
    const { data, info } = await sharp(img.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    catalog.setImageBounds(id, opaqueBounds(data, info.width, info.height), catalog.imageRenderedAt(id) ?? new Date().toISOString().slice(0, 19).replace('T', ' '));
  }
}

/**
 * One-time (28 Nov): cut-outs rendered by the retired INT8 build (from its deploy at
 * 00:54 UTC) notched clear-glass edges. Record each image's model and real render
 * time, and queue the INT8 ones for a full-precision re-render (served until replaced).
 */
function migrateInt8Renders(): void {
  const done = catalog.runOnce('2026-11-28-int8-rerender', () => {
    const db = catalog.rawDb();
    db.exec(`
      UPDATE image_meta SET
        rendered_at = COALESCE((SELECT fetched_at FROM image_cache_v4 i WHERE i.id = image_meta.id AND i.width = 240), rendered_at),
        model = CASE WHEN (SELECT fetched_at FROM image_cache_v4 i WHERE i.id = image_meta.id AND i.width = 240) >= '2026-11-28 00:54:00'
                     THEN 'bria-int8' ELSE 'bria' END
    `);
    db.exec(`
      INSERT OR IGNORE INTO image_jobs (id, priority)
      SELECT id, 0 FROM image_meta WHERE model = 'bria-int8'
    `);
  });
  if (done) logger.info('Queued INT8 cut-outs for a full-precision re-render');
}

/**
 * Cut-outs made before the clear-glass repair (sealGlass): check each one's stored mask and
 * queue a re-render only where the repair would change it; mark the rest as current.
 * Resumable: rows keep the old id until checked.
 */
async function migrateGlassSeal(): Promise<void> {
  if (maskNeedsRefine()) return;
  const db = catalog.rawDb();
  const rows = db.prepare('SELECT id FROM image_meta WHERE model = ?').all(modelId()) as Array<{ id: number }>;
  const mark = db.prepare('UPDATE image_meta SET model = ? WHERE id = ?');
  let queued = 0;
  for (const { id } of rows) {
    const img = catalog.getImage(id, IMAGE_SIZES.large);
    if (!img) continue;
    const { data, info } = await sharp(img.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    const alpha = Buffer.alloc(n);
    const photo = Buffer.from(data);
    for (let p = 0; p < n; p++) {
      const a = data[p * 4 + 3];
      alpha[p] = a;
      // The stored WebP drops colour under transparent pixels: put the white backdrop back
      for (let c = 0; c < 3; c++) photo[p * 4 + c] = Math.round((data[p * 4 + c] * a + 255 * (255 - a)) / 255);
    }
    if (sealGlass(alpha, info.width, info.height, photo).equals(alpha)) {
      mark.run(renderId(), id);
    } else {
      catalog.enqueueImageJob(id, PRIORITY.upgrade);
      queued++;
    }
    await new Promise((r) => setImmediate(r));
  }
  if (rows.length) logger.info(`Clear-glass repair: checked ${rows.length} cut-outs, queued ${queued} for a re-render`);
}

/** Basic records for several ids (in the order given; unknown ids are left out). */
export function byIds(ids: number[]): CatalogRow[] {
  return catalog.getByIds(ids);
}

/** Fill an empty catalog with the most popular perfumes, slowly, in the background. */
export async function seed(): Promise<void> {
  if (modelId() === 'bria') migrateInt8Renders();
  await backfillImageMeta().catch((err) => logger.warn(`Image bounds backfill failed: ${(err as Error).message}`));
  await migrateGlassSeal().catch((err) => logger.warn(`Clear-glass check failed: ${(err as Error).message}`));
  if (!maskNeedsRefine()) await purgeUncutImages().catch((err) => logger.warn(`Image cleanup failed: ${(err as Error).message}`));
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
