import { Router, Request, Response } from 'express';
import { z } from 'zod';
import config from '../../config/config';
import { asyncHandler } from '../middleware/errorHandler';
import { validate } from '../middleware/validate';
import { sendSuccess, sendError } from '../../utils/apiResponse';
import { positiveIntParam } from '../validation/zodHelpers';
import * as service from '../../catalog/service';

export function baseUrl(req: Request): string {
  return config.api.publicUrl || `${req.protocol}://${req.get('host')}`;
}

const router = Router();

const autocompleteQuery = z.object({
  q: z.string().trim().min(1, 'q is required').max(100),
  limit: positiveIntParam('limit', { min: 1, max: 50, default: 8 }),
  brand: z.string().trim().min(1).max(100).optional(),
});

/** GET /api/autocomplete?q=cre&limit=8[&brand=Creed] */
router.get('/autocomplete', validate({ query: autocompleteQuery }), asyncHandler(async (req: Request, res: Response) => {
  const { q, limit, brand } = req.query as unknown as { q: string; limit: number; brand?: string };
  const ranked = await service.autocomplete(q, limit, brand);
  // Keystrokes are frequent: prepare only the top suggestions' images ahead of time
  service.prefetchImages(ranked.slice(0, 3).map((r) => r.row.id));
  return sendSuccess(res, ranked.map((r) => service.toItem(r.row, baseUrl(req))));
}));

const matchInput = z.object({
  text: z.string().trim().min(1, 'text is required').max(500),
  limit: positiveIntParam('limit', { min: 1, max: 10, default: 5 }),
});

async function handleMatch(req: Request, res: Response, text: string, limit: number) {
  const ranked = await service.match(text, limit);
  service.prefetchImages(ranked.slice(0, 1).map((r) => r.row.id));
  return sendSuccess(res, matchResult(req, ranked));
}

/** GET /api/match?text=CREED AVENTUS eau de parfum 100ml */
router.get('/match', validate({ query: matchInput }), asyncHandler(async (req: Request, res: Response) => {
  const { text, limit } = req.query as unknown as { text: string; limit: number };
  return handleMatch(req, res, text, limit);
}));

function matchResult(req: Request, ranked: Array<{ row: import('../../catalog/catalog').CatalogRow; score: number }>) {
  const base = baseUrl(req);
  const top = ranked[0];
  const ok = !!top && top.score >= 0.55;
  return {
    match: ok ? { ...service.toItem(top.row, base), confidence: top.score } : null,
    alternatives: ranked.slice(ok ? 1 : 0).map((r) => ({ ...service.toItem(r.row, base), confidence: r.score })),
  };
}

const matchBody = z.union([
  z.object({ text: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(10).optional() }),
  z.object({ texts: z.array(z.string().trim().min(1).max(2000)).min(1).max(20), limit: z.number().int().min(1).max(10).optional() }),
]);

/**
 * POST /api/match { "text": "..." } for one text, or { "texts": [...] } (up to 20,
 * e.g. every bottle read from one shelf photo) for one result per text, in order.
 */
router.post('/match', validate({ body: matchBody }), asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as { text?: string; texts?: string[]; limit?: number };
  const limit = body.limit ?? 5;
  if (body.texts) {
    const results = await mapLimit(body.texts, 3, async (text) => {
      const ranked = await service.match(text, limit);
      service.prefetchImages(ranked.slice(0, 1).map((r) => r.row.id));
      return { text, ...matchResult(req, ranked) };
    });
    return sendSuccess(res, results);
  }
  return handleMatch(req, res, body.text!, limit);
}));

async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const idsQuery = z.object({
  ids: z.string().regex(/^\d+(,\d+)*$/, 'ids must be comma-separated numbers')
    .transform((v) => [...new Set(v.split(',').map(Number))])
    .refine((v) => v.length <= 50, 'at most 50 ids'),
});

/** GET /api/perfumes?ids=1,2,3 (up to 50): basic records with image state, in the order given */
router.get('/perfumes', validate({ query: idsQuery }), asyncHandler(async (req: Request, res: Response) => {
  const { ids } = req.query as unknown as { ids: number[] };
  const base = baseUrl(req);
  return sendSuccess(res, service.byIds(ids).map((r) => service.toItem(r, base)));
}));

/** GET /api/perfumes/:id */
router.get('/perfumes/:id', validate({ params: z.object({ id: positiveIntParam('id') }) }), asyncHandler(async (req: Request, res: Response) => {
  const detail = await service.detail(Number(req.params.id), baseUrl(req));
  service.prefetchImages([detail.id]);
  return sendSuccess(res, detail);
}));

/** GET /api/brands/:name?page=1 */
router.get('/brands/:name', validate({
  params: z.object({ name: z.string().trim().min(1).max(100) }),
  query: z.object({ page: positiveIntParam('page', { min: 1, max: 500, default: 1 }) }),
}), asyncHandler(async (req: Request, res: Response) => {
  const rows = await service.brand(req.params.name, (req.query as unknown as { page: number }).page);
  return sendSuccess(res, rows.map((r) => service.toItem(r, baseUrl(req))));
}));

const rankingsQuery = z.object({
  category: z.enum(['mens', 'womens', 'unisex']),
  page: positiveIntParam('page', { min: 1, max: 100, default: 1 }),
  limit: positiveIntParam('limit', { min: 1, max: 100, default: 20 }),
  production: z.enum(['in-production', 'discontinued', 'all']).optional().default('all'),
  edition: z.enum(['regular', 'limited', 'collectors', 'all']).optional().default('all'),
});

/** GET /api/rankings?category=unisex */
router.get('/rankings', validate({ query: rankingsQuery }), asyncHandler(async (req: Request, res: Response) => {
  const { category, page, limit, production, edition } = req.query as unknown as z.infer<typeof rankingsQuery>;
  const rows = await service.rankings(category, page, production, edition);
  const base = baseUrl(req);
  return sendSuccess(res, rows.slice(0, limit).map((r, i) => ({ rank: (page - 1) * rows.length + i + 1, ...service.toItem(r, base) })));
}));

export default router;

/** Public image route: GET /images/:id.webp?size=small|large (no API key, for <img> tags). */
export const imagesRouter = Router();
imagesRouter.get('/:id.:ext(webp|jpg)', asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) return sendError(res, 'Invalid image id', 400);
  const size = req.query.size === 'xl' ? 'xl' : req.query.size === 'large' ? 'large' : 'small';
  const img = await service.image(id, size);
  if (!img) return sendError(res, 'Image not found', 404);
  res.setHeader('Content-Type', img.type);
  // Plain photo while the cut-out is queued: browsers must revalidate (ETag) every time,
  // so the same URL shows the cut-out as soon as it is ready; edge caches skip it
  res.setHeader('Cache-Control', img.final ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('ETag', `"${id}-${img.final ? 'final' : 'plain'}-${size}-${req.query.t ?? ''}"`);
  if (req.fresh) return res.status(304).end();
  return res.send(img.body);
}));
