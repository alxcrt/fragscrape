import type Database from 'better-sqlite3';
import database from '../database/database';
import { normalizeText, tokenize, tokenWeight } from './normalize';
import type { ListingItem } from './source';

export interface CatalogRow {
  id: number;
  path: string | null;
  media_key: string | null;
  image: string | null;
  name: string;
  brand: string;
  variant: string | null;
  year: number | null;
  gender: string | null;
  rating: number | null;
  votes: number | null;
}

let db: Database.Database;

/** Create the catalog tables. Call after database.initialize(). */
export function initCatalog(): void {
  db = database.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE,
      media_key TEXT UNIQUE,
      image TEXT,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      variant TEXT,
      year INTEGER,
      gender TEXT,
      rating REAL,
      votes INTEGER,
      search_text TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
      search_text, content='catalog', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS catalog_ai AFTER INSERT ON catalog BEGIN
      INSERT INTO catalog_fts(rowid, search_text) VALUES (new.id, new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_ad AFTER DELETE ON catalog BEGIN
      INSERT INTO catalog_fts(catalog_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_au AFTER UPDATE OF search_text ON catalog BEGIN
      INSERT INTO catalog_fts(catalog_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
      INSERT INTO catalog_fts(rowid, search_text) VALUES (new.id, new.search_text);
    END;
    CREATE TABLE IF NOT EXISTS list_cache (
      key TEXT PRIMARY KEY,
      ids TEXT NOT NULL,
      fetched_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS image_cache_v3 (
      id INTEGER NOT NULL,
      width INTEGER NOT NULL,
      type TEXT NOT NULL,
      data BLOB NOT NULL,
      fetched_at DATETIME NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id, width)
    );
    CREATE TABLE IF NOT EXISTS live_queries (
      query TEXT PRIMARY KEY,
      result_count INTEGER NOT NULL,
      fetched_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Images from earlier pipelines are rebuilt
  db.exec('DROP TABLE IF EXISTS image_cache; DROP TABLE IF EXISTS image_cache_v2');
  // Similar perfumes for a detail page, as [{ id, similarity }]
  try { db.exec('ALTER TABLE catalog ADD COLUMN similar TEXT'); } catch { /* exists */ }
}

const searchText = (item: Pick<ListingItem, 'brand' | 'name' | 'variant'>) =>
  ` ${normalizeText(`${item.brand} ${item.name} ${item.variant ?? ''}`)} `;

/**
 * Insert or update a perfume, matched by source path first, then image key.
 * Returns its id. Ids never change once handed out.
 */
export function upsertItem(item: ListingItem): number {
  const byPath = item.path ? db.prepare('SELECT id FROM catalog WHERE path = ?').get(item.path) as { id: number } | undefined : undefined;
  const byMedia = item.mediaKey ? db.prepare('SELECT id FROM catalog WHERE media_key = ?').get(item.mediaKey) as { id: number } | undefined : undefined;
  const target = byPath ?? byMedia;
  if (target) {
    // Two rows can describe one perfume (one found by link, one by image); never merge ids
    const mediaKey = byMedia && byMedia.id !== target.id ? null : item.mediaKey;
    db.prepare(`
      UPDATE catalog SET
        path = COALESCE(?, path), media_key = COALESCE(?, media_key), image = COALESCE(?, image),
        name = ?, brand = ?, variant = COALESCE(?, variant), year = COALESCE(?, year),
        gender = COALESCE(?, gender), rating = COALESCE(?, rating), votes = COALESCE(?, votes),
        search_text = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(item.path, mediaKey, item.image, item.name, item.brand, item.variant, item.year,
      item.gender, item.rating, item.votes, searchText(item), target.id);
    return target.id;
  }
  const result = db.prepare(`
    INSERT INTO catalog (path, media_key, image, name, brand, variant, year, gender, rating, votes, search_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(item.path, item.mediaKey, item.image, item.name, item.brand, item.variant, item.year,
    item.gender, item.rating, item.votes, searchText(item));
  return Number(result.lastInsertRowid);
}

export function upsertItems(items: ListingItem[]): CatalogRow[] {
  const tx = db.transaction((list: ListingItem[]) => list.map((item) => upsertItem(item)));
  const ids = tx(items);
  return ids.map((id) => getById(id)!).filter(Boolean);
}

export function getById(id: number): CatalogRow | undefined {
  return db.prepare('SELECT * FROM catalog WHERE id = ?').get(id) as CatalogRow | undefined;
}

export function count(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM catalog').get() as { n: number }).n;
}

/** Candidate rows for free text: trigram overlap first, prefix fallback for 1-2 letter words. */
export function candidates(query: string, limit = 300): CatalogRow[] {
  const tokens = tokenize(query).filter((t) => tokenWeight(t) > 0);
  const grams = new Set<string>();
  for (const t of [...tokens].sort((a, b) => b.length - a.length)) {
    for (let i = 0; i + 3 <= t.length && grams.size < 40; i++) grams.add(t.slice(i, i + 3));
  }
  const rows = new Map<number, CatalogRow>();
  if (grams.size > 0) {
    const expr = [...grams].map((g) => `"${g}"`).join(' OR ');
    for (const row of db.prepare(`
      SELECT c.* FROM catalog_fts f JOIN catalog c ON c.id = f.rowid
      WHERE catalog_fts MATCH ? ORDER BY bm25(catalog_fts) LIMIT ?
    `).all(expr, limit) as CatalogRow[]) rows.set(row.id, row);
  }
  const short = tokens.filter((t) => t.length < 3);
  if (short.length > 0 && rows.size < limit) {
    for (const t of short) {
      for (const row of db.prepare(`
        SELECT * FROM catalog WHERE search_text LIKE ? ORDER BY votes DESC LIMIT ?
      `).all(`% ${t}%`, limit) as CatalogRow[]) rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

/** Whether a live lookup for this text ran recently (results kept 7 days, empty ones 1 day). */
export function recentlyQueried(query: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM live_queries WHERE query = ?
    AND fetched_at > datetime('now', CASE WHEN result_count > 0 THEN '-7 days' ELSE '-1 day' END)
  `).get(normalizeText(query));
  return !!row;
}

export function markQueried(query: string, resultCount: number): void {
  db.prepare(`
    INSERT INTO live_queries (query, result_count, fetched_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(query) DO UPDATE SET result_count = excluded.result_count, fetched_at = excluded.fetched_at
  `).run(normalizeText(query), resultCount);
}

export function setSimilar(id: number, similar: Array<{ id: number; similarity?: number }>): void {
  db.prepare('UPDATE catalog SET similar = ? WHERE id = ?').run(JSON.stringify(similar), id);
}

export function getSimilar(id: number): Array<{ id: number; similarity?: number }> | null {
  const row = db.prepare('SELECT similar FROM catalog WHERE id = ?').get(id) as { similar: string | null } | undefined;
  return row?.similar ? JSON.parse(row.similar) : null;
}

export function getList(key: string): { ids: number[]; ageSeconds: number } | null {
  const row = db.prepare(`
    SELECT ids, (julianday('now') - julianday(fetched_at)) * 86400 AS age FROM list_cache WHERE key = ?
  `).get(key) as { ids: string; age: number } | undefined;
  return row ? { ids: JSON.parse(row.ids), ageSeconds: row.age } : null;
}

export function setList(key: string, ids: number[]): void {
  db.prepare(`
    INSERT INTO list_cache (key, ids, fetched_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET ids = excluded.ids, fetched_at = excluded.fetched_at
  `).run(key, JSON.stringify(ids));
}

export function getImage(id: number, width: number): { type: string; data: Buffer } | null {
  return (db.prepare('SELECT type, data FROM image_cache_v3 WHERE id = ? AND width = ?').get(id, width) as { type: string; data: Buffer } | undefined) ?? null;
}

export function setImage(id: number, width: number, type: string, data: Buffer): void {
  db.prepare('INSERT OR REPLACE INTO image_cache_v3 (id, width, type, data) VALUES (?, ?, ?, ?)').run(id, width, type, data);
}
