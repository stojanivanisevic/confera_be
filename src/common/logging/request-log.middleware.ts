import type { NextFunction, Request, Response } from 'express';
import { currentTraceId } from '../http/trace';
import type { AppLogger } from './app-logger';

/** Paths that are asked every few seconds by a health check; logged at debug level only. */
const QUIET_ROUTES = new Set(['/health']);

/**
 * One log line per request, written when the response is finished.
 *
 * It holds the method, the ROUTE (the pattern, such as `/public/v1/links/:token`), the
 * status and the duration. It never holds the address that was asked, a query string, a
 * header or a body: a path can carry a secure-link token and a query can carry anything
 * (govcore finding 15, NFR-PRIV-04).
 */
export function requestLog(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    const traceId = currentTraceId();
    res.on('finish', () => {
      const route = (req.route as { path?: unknown } | undefined)?.path;
      const fields = {
        traceId,
        method: req.method,
        route: typeof route === 'string' ? route : '(no route)',
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      };
      if (QUIET_ROUTES.has(fields.route) && res.statusCode < 400) {
        logger.debug('request', fields);
      } else {
        logger.info('request', fields);
      }
    });
    next();
  };
}
