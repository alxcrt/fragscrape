import Database from 'better-sqlite3';

const mem = new Database(':memory:');
jest.mock('../../src/database/database', () => ({ __esModule: true, default: { getDb: () => mem } }));

import * as catalog from '../../src/catalog/catalog';
import type { ListingItem } from '../../src/catalog/source';

const base: ListingItem = {
  path: null, mediaKey: null, image: null, name: '', brand: '', variant: null, year: null, gender: null, rating: null, votes: null,
};

beforeAll(() => catalog.initCatalog());

describe('catalog', () => {
  it('upserts by path and keeps ids stable', () => {
    const id = catalog.upsertItem({ ...base, path: 'Creed/aventus', mediaKey: '66dd48', name: 'Aventus', brand: 'Creed', votes: 1 });
    const again = catalog.upsertItem({ ...base, path: 'Creed/aventus', name: 'Aventus', brand: 'Creed', votes: 8900 });
    expect(again).toBe(id);
    expect(catalog.getById(id)).toMatchObject({ votes: 8900, media_key: '66dd48' });
  });

  it('links an image-only entry to its page later', () => {
    const id = catalog.upsertItem({ ...base, mediaKey: 'f7f71f', name: 'Club de Nuit Intense Man', brand: 'Armaf' });
    expect(catalog.upsertItem({ ...base, path: 'Armaf/club', mediaKey: 'f7f71f', name: 'Club de Nuit Intense Man', brand: 'Armaf' })).toBe(id);
    expect(catalog.getById(id)?.path).toBe('Armaf/club');
  });

  it('finds candidates by fuzzy trigrams and short prefixes', () => {
    const typo = catalog.candidates('avnetus').map((r) => r.name);
    expect(typo).toContain('Aventus');
    expect(catalog.candidates('cr').map((r) => r.brand)).toContain('Creed');
  });

  it('remembers live lookups', () => {
    expect(catalog.recentlyQueried('Aventus')).toBe(false);
    catalog.markQueried('Aventus', 3);
    expect(catalog.recentlyQueried('aventus')).toBe(true);
  });

  it('queues image jobs by priority, newest first, and gives up after 3 failures', () => {
    catalog.enqueueImageJob(10, 1);
    catalog.enqueueImageJob(11, 1);
    catalog.enqueueImageJob(12, 2);
    expect(catalog.nextImageJob()).toBe(12);
    catalog.finishImageJob(12);
    expect(catalog.nextImageJob()).toBe(11); // most recent of equal priority
    catalog.enqueueImageJob(10, 2); // viewed: jumps ahead
    expect(catalog.nextImageJob()).toBe(10);
    for (let i = 0; i < 3; i++) catalog.failImageJob(10);
    expect(catalog.nextImageJob()).toBe(11);
    expect(catalog.imageQueueLength()).toBe(1);
  });

  it('knows whether the final image or a plain fallback is stored', () => {
    expect(catalog.hasFinalImage(20, 240)).toBe(false);
    catalog.setPlainImage(20, 240, Buffer.from('p'));
    expect(catalog.getPlainImage(20, 240)?.toString()).toBe('p');
    catalog.setImage(20, 240, 'image/webp', Buffer.from('f'));
    expect(catalog.hasFinalImage(20, 240)).toBe(true);
  });

  it('lists and deletes final images', () => {
    catalog.setImage(30, 240, 'image/webp', Buffer.from('a'));
    catalog.setImage(30, 720, 'image/webp', Buffer.from('b'));
    expect(catalog.finalImageIds(240)).toContain(30);
    catalog.deleteFinalImages(30);
    expect(catalog.hasFinalImage(30, 240) || catalog.hasFinalImage(30, 720)).toBe(false);
  });

  it('stores lists, similar ids and images', () => {
    catalog.setList('k', [1, 2]);
    expect(catalog.getList('k')?.ids).toEqual([1, 2]);
    catalog.setSimilar(1, [{ id: 2, similarity: 0.5 }]);
    expect(catalog.getSimilar(1)).toEqual([{ id: 2, similarity: 0.5 }]);
    catalog.setImage(1, 240, 'image/webp', Buffer.from('x'));
    expect(catalog.getImage(1, 240)?.data.toString()).toBe('x');
  });
});
