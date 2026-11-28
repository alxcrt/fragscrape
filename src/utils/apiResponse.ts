import { Response } from 'express';
import { ApiResponse } from '../types';

/**
 * Send a successful API response
 */
export function sendSuccess<T>(res: Response, data: T, statusCode: number = 200): Response {
  const response: ApiResponse<T> = {
    success: true,
    data,
    timestamp: new Date(),
  };
  return res.status(statusCode).json(response);
}

/** Stable machine-readable code for an HTTP status. */
export function errorCode(statusCode: number): string {
  switch (statusCode) {
    case 400: return 'invalid_request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 429: return 'rate_limited';
    case 502: return 'upstream_error';
    case 503: return 'unavailable';
    default: return statusCode >= 500 ? 'internal_error' : 'error';
  }
}

/**
 * Send an error API response: { success: false, code, error }
 */
export function sendError(res: Response, error: string, statusCode: number = 500, code?: string): Response {
  const response: ApiResponse<null> = {
    success: false,
    code: code ?? errorCode(statusCode),
    error,
    timestamp: new Date(),
  };
  return res.status(statusCode).json(response);
}
