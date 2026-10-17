import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProblemException } from '../../common/http/problem';

/**
 * Only Confera's own page may call the changing routes of the public forms (ADR-08,
 * SEC-A-06, ST-31). The access guard has already checked that `Origin` equals the public
 * origin exactly. This guard adds, before any body is read or checked:
 *
 * - `Sec-Fetch-Site`, where the browser sends it, must be `same-origin`;
 * - the route takes exactly one content type: JSON for a token and a submit, multipart for
 *   an upload. An HTML form (`text/plain`, `application/x-www-form-urlencoded`) is refused.
 */
const OWN_PAGE = 'confera:own-page';

type ContentType = 'application/json' | 'multipart/form-data';

export function OwnPage(type: ContentType): MethodDecorator {
  return applyDecorators(SetMetadata(OWN_PAGE, type), UseGuards(OwnPageGuard));
}

@Injectable()
export class OwnPageGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const type = this.reflector.get<ContentType | undefined>(OWN_PAGE, context.getHandler());
    const request = context.switchToHttp().getRequest<Request>();
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') {
      throw new ProblemException(403, 'fetch_site_refused');
    }
    const given = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === undefined || given !== type) {
      throw new ProblemException(415, 'unsupported_media_type');
    }
    return true;
  }
}
