import type { NextFunction, Request, Response } from 'express';

/**
 * The headers of every API response (ADR-28: "the API sets its own"; the web application
 * sets those of pages, the proxy adds HSTS only).
 *
 * The API answers with data, never with a page, so its policy allows nothing: no script,
 * no frame, no cache. No CORS header is ever set: every call is same-origin.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  next();
}
