import { Request, Response, NextFunction } from 'express';
import config from '../../config/config';
import { sendError } from '../../utils/apiResponse';

/**
 * Parfumo account features (login, collection, ratings, reviews, sync push/pull)
 * drive a visible Chrome window. On a headless server set PARFUMO_AUTH_ENABLED=false
 * so these routes return 503 instead of failing to launch a browser.
 */
export function requireParfumoAuthEnabled(_req: Request, res: Response, next: NextFunction) {
  if (config.parfumo.authEnabled) return next();
  return sendError(
    res,
    'Parfumo account features are disabled on this server (PARFUMO_AUTH_ENABLED=false): they need a visible browser for login',
    503
  );
}
