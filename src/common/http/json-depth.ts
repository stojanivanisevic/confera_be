import type { NextFunction, Request, Response } from 'express';

/**
 * How deep a JSON body may be nested (E2-07). The deepest request of the API, a template
 * document, has a depth of about 20; a body of thousands of levels ends the stack of the
 * validation that walks it, and is refused right after it is parsed.
 */
export const JSON_MAX_DEPTH = 64;

/** The deepest nesting of objects and arrays in a parsed value, found without recursion. */
export function nestingDepth(value: unknown): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[value, 0]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [current, depth] = item;
    if (current === null || typeof current !== 'object') {
      continue;
    }
    const level = depth + 1;
    if (level > deepest) {
      deepest = level;
      if (deepest > JSON_MAX_DEPTH) {
        return deepest;
      }
    }
    for (const child of Object.values(current as Record<string, unknown>)) {
      stack.push([child, level]);
    }
  }
  return deepest;
}

/** Refuses a body nested deeper than JSON_MAX_DEPTH with 400, before any validation sees it. */
export function refuseDeepBodies(request: Request, _response: Response, next: NextFunction): void {
  if (nestingDepth(request.body as unknown) > JSON_MAX_DEPTH) {
    next(
      Object.assign(new Error('The body is nested too deeply.'), {
        status: 400,
        statusCode: 400,
        expose: true,
        type: 'entity.too.deep',
      }),
    );
    return;
  }
  next();
}
