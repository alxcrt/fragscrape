import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import config from '../../config/config';
import { sendError } from '../../utils/apiResponse';

const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
const keyDigests = config.api.apiKeys.map(digest);

/**
 * Extract a key from `X-API-Key: <key>` or `Authorization: Bearer <key>`.
 */
function presentedKey(req: Request): string | undefined {
  const header = req.get('x-api-key');
  if (header) return header.trim();
  const auth = req.get('authorization');
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

/**
 * Require a configured API key when API_KEYS is set. With no keys configured
 * the API stays open (local development); set REQUIRE_API_KEY=true to refuse
 * to start without keys instead.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  if (keyDigests.length === 0) return next();
  const key = presentedKey(req);
  if (key) {
    const candidate = digest(key);
    // Compare against every key so timing doesn't reveal which one matched
    let ok = false;
    for (const known of keyDigests) {
      if (crypto.timingSafeEqual(candidate, known)) ok = true;
    }
    if (ok) return next();
  }
  res.setHeader('WWW-Authenticate', 'Bearer realm="fragscrape"');
  return sendError(res, 'Missing or invalid API key (send X-API-Key or Authorization: Bearer)', 401);
}
