import { randomUUID } from 'node:crypto';
import { ClsMiddleware, ClsServiceManager } from 'nestjs-cls';

export const TRACE_HEADER = 'X-Trace-Id';

/**
 * Opens the request context and gives the request its trace id.
 * The id is always made here; one sent by a client is never used, so a client cannot
 * write into the log or pick another request's id.
 */
export function requestContext(): ClsMiddleware['use'] {
  const middleware = new ClsMiddleware({
    generateId: true,
    idGenerator: () => randomUUID(),
    setup: (cls, _req, res: { setHeader(name: string, value: string): void }) => {
      res.setHeader(TRACE_HEADER, cls.getId());
    },
  });
  return middleware.use;
}

/** Trace id of the current request. Outside a request (start-up, jobs) a fresh id. */
export function currentTraceId(): string {
  const cls = ClsServiceManager.getClsService();
  const id = cls.isActive() ? (cls.getId() as string | undefined) : undefined;
  return id ?? randomUUID();
}
