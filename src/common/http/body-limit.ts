import type { NextFunction, Request, Response } from 'express';
import { ProblemException, sendProblem, toProblem } from './problem';
import { currentTraceId } from './trace';

/**
 * Refuses a request whose body is larger than `bytes` before any of it is read: by its
 * Content-Length, or, for a chunked body, as soon as more than `bytes` have arrived. For
 * a path whose limit is smaller than the general one (the reports of the content
 * security policy, M1-ISS-11).
 */
export function bodyLimit(bytes: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const refuse = (): void => {
      sendProblem(res, toProblem(new ProblemException(413, 'payload_too_large'), currentTraceId()));
    };
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > bytes) {
      refuse();
      return;
    }
    let received = 0;
    req.on('data', (chunk: Buffer | string) => {
      received += chunk.length;
      if (received > bytes && !res.headersSent) {
        refuse();
        req.destroy();
      }
    });
    next();
  };
}
