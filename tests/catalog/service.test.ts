import Database from 'better-sqlite3';

const mem = new Database(':memory:');
jest.mock('../../src/database/database', () => ({ __esModule: true, default: { getDb: () => mem } }));

import * as catalog from '../../src/catalog/catalog';
import { cleanName, opaqueBounds, toItem, IMAGE_VERSION } from '../../src/catalog/service';
import { errorCode } from '../../src/utils/apiResponse';

beforeAll(() => catalog.initCatalog());

describe('cleanName', () => {
  it('moves a trailing year into year', () => {
    expect(cleanName('Dior Homme Intense (2011)', null)).toEqual({ name: 'Dior Homme Intense', year: 2011 });
  });
  it('keeps an existing year and other names untouched', () => {
    expect(cleanName('Ombré Leather (2018)', 2018)).toEqual({ name: 'Ombré Leather', year: 2018 });
    expect(cleanName('Baccarat Rouge 540', 2015)).toEqual({ name: 'Baccarat Rouge 540', year: 2015 });
    expect(cleanName('Pornstar (Noyau Doux)', null)).toEqual({ name: 'Pornstar (Noyau Doux)', year: null });
  });
});

describe('opaqueBounds', () => {
  it('returns the opaque box as fractions', () => {
    const w = 10, h = 20, rgba = Buffer.alloc(w * h * 4, 0);
    for (let y = 5; y < 15; y++) for (let x = 2; x < 8; x++) rgba[(y * w + x) * 4 + 3] = 255;
    expect(opaqueBounds(rgba, w, h)).toEqual({ x: 0.2, y: 0.25, w: 0.6, h: 0.5 });
  });
  it('is null for a fully transparent image', () => {
    expect(opaqueBounds(Buffer.alloc(16, 0), 2, 2)).toBeNull();
  });
});

describe('toItem image state', () => {
  const base = { path: null, mediaKey: null, name: 'Aventus', brand: 'Creed', variant: null, year: 2010, gender: null, rating: null, votes: null };
  it('reports pending, ready and none', () => {
    const withImage = catalog.upsertItem({ ...base, path: 'Creed/aventus', image: 'perfumes/66/66dd48_x.jpg' });
    const noImage = catalog.upsertItem({ ...base, path: 'Creed/none', name: 'Ghost', image: null });
    expect(toItem(catalog.getById(withImage)!, 'https://h')).toMatchObject({ imageStatus: 'pending', imageVersion: IMAGE_VERSION, image: expect.stringContaining('&pending=1') });
    expect(toItem(catalog.getById(noImage)!, 'https://h')).toMatchObject({ imageStatus: 'none' });
    expect(toItem(catalog.getById(noImage)!, 'https://h').image).toBeUndefined();
    catalog.setImage(withImage, 240, 'image/webp', Buffer.from('x'));
    catalog.setImageMeta(withImage, { x: 0.1, y: 0.05, w: 0.8, h: 0.9 });
    const ready = toItem(catalog.getById(withImage)!, 'https://h');
    expect(ready).toMatchObject({ imageStatus: 'ready', imageBounds: { x: 0.1, y: 0.05, w: 0.8, h: 0.9 } });
    expect(ready.image).not.toContain('pending');
    expect(ready.imageUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns records for several ids in order, skipping unknown ones', () => {
    const a = catalog.upsertItem({ ...base, path: 'A/a', name: 'A', image: null });
    const b = catalog.upsertItem({ ...base, path: 'B/b', name: 'B', image: null });
    expect(catalog.getByIds([b, 999999, a]).map((r) => r.id)).toEqual([b, a]);
  });
});

describe('errorCode', () => {
  it('maps statuses to stable codes', () => {
    expect([400, 401, 404, 429, 502, 500].map(errorCode)).toEqual(['invalid_request', 'unauthorized', 'not_found', 'rate_limited', 'upstream_error', 'internal_error']);
  });
});
