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
  limit: positiveIntParam('limit', { min: 1, max: 20, default: 8 }),
});

/** GET /api/autocomplete?q=cre&limit=8 */
router.get('/autocomplete', validate({ query: autocompleteQuery }), asyncHandler(async (req: Request, res: Response) => {
  const { q, limit } = req.query as unknown as { q: string; limit: number };
  const ranked = await service.autocomplete(q, limit);
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
  service.prefetchImages(ranked.map((r) => r.row.id));
  const base = baseUrl(req);
  const top = ranked[0];
  return sendSuccess(res, {
    match: top && top.score >= 0.55 ? { ...service.toItem(top.row, base), confidence: top.score } : null,
    alternatives: ranked.slice(top && top.score >= 0.55 ? 1 : 0).map((r) => ({ ...service.toItem(r.row, base), confidence: r.score })),
  });
}

/** GET /api/match?text=CREED AVENTUS eau de parfum 100ml */
router.get('/match', validate({ query: matchInput }), asyncHandler(async (req: Request, res: Response) => {
  const { text, limit } = req.query as unknown as { text: string; limit: number };
  return handleMatch(req, res, text, limit);
}));

/** POST /api/match { "text": "..." } for longer text */
router.post('/match', validate({ body: z.object({ text: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(10).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { text, limit } = req.body as { text: string; limit?: number };
    return handleMatch(req, res, text, limit ?? 5);
  }));

/** GET /api/perfumes/:id */
router.get('/perfumes/:id', validate({ params: z.object({ id: positiveIntParam('id') }) }), asyncHandler(async (req: Request, res: Response) => {
  const detail = await service.detail(Number(req.params.id), baseUrl(req));
  service.prefetchImages([detail.id, ...detail.similar.map((s) => s.id)]);
  return sendSuccess(res, detail);
}));

/** GET /api/brands/:name?page=1 */
router.get('/brands/:name', validate({
  params: z.object({ name: z.string().trim().min(1).max(100) }),
  query: z.object({ page: positiveIntParam('page', { min: 1, max: 500, default: 1 }) }),
}), asyncHandler(async (req: Request, res: Response) => {
  const rows = await service.brand(req.params.name, (req.query as unknown as { page: number }).page);
  service.prefetchImages(rows.map((r) => r.id));
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
  service.prefetchImages(rows.slice(0, limit).map((r) => r.id));
  const base = baseUrl(req);
  return sendSuccess(res, rows.slice(0, limit).map((r, i) => ({ rank: (page - 1) * rows.length + i + 1, ...service.toItem(r, base) })));
}));

export default router;

/** Public image route: GET /images/:id.webp?size=small|large (no API key, for <img> tags). */
export const imagesRouter = Router();
imagesRouter.get('/:id.:ext(webp|jpg)', asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) return sendError(res, 'Invalid image id', 400);
  const img = await service.image(id, req.query.size === 'large' ? 'large' : 'small');
  if (!img) return sendError(res, 'Image not found', 404);
  res.setHeader('Content-Type', img.type);
  // Untouched original while the AI cut-out is not ready: cache briefly
  res.setHeader('Cache-Control', img.final ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
  return res.send(img.body);
}));
