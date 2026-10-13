import type { NextFunction, Request, Response } from 'express';

/**
 * Confera's APIs are same-origin only (ADR-07, ADR-08): no route ever grants
 * cross-origin access, so no browser preflight can succeed.
 *
 * Express would answer an OPTIONS request for an existing path with 200 and an `Allow`
 * header. That is not a grant, but it is not a clear "no" either; this middleware makes
 * every OPTIONS request a 405 before any route is looked at (test ST-65).
 */
export function refusePreflight(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') {
    res.status(405).end();
    return;
  }
  next();
}
