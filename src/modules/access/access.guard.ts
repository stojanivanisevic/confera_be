import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProblemException } from '../../common/http/problem';
import { type Surface, SURFACE_KEY } from '../../common/http/surface';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { ROUTE_ACCESS_METADATA, FRESH_PASSWORD_KEY, type RouteAccess } from './access.decorators';
import { cookieValue, SESSION_COOKIE } from './cookies';
import { SessionService, type SessionState } from './session.service';
import { csrfValueOf, sameText } from './tokens';

/** The header of every changing request of a signed-in user: the CSRF value of the session (ADR-03). */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * A request that the web application makes by itself, without the person doing anything
 * (a background refetch), says so with this header; it does not renew the session
 * (ADR-03: "background refetches do not renew").
 */
export const BACKGROUND_HEADER = 'x-confera-background';

const READING = new Set(['GET', 'HEAD']);

/**
 * The access guard (ADR-03, ADR-05; ST-13, ST-66). It runs after the surface guard, on
 * every route, and denies by default:
 *
 * 1. A changing request (anything but GET and HEAD) must carry an `Origin` that equals the
 *    origin of the route's own surface exactly: the public host's origin is refused on the
 *    admin surface, and a request without an Origin is refused. (The reports of the content
 *    security policy, which change nothing, are the one exception, `@Public({ anyOrigin })`.)
 * 2. A public route needs nothing more.
 * 3. Any other route needs a session: the `__Host-` session cookie, a session that has not
 *    ended or expired, an active user. Its organisation becomes the organisation of the
 *    request, for row-level security.
 * 4. A changing request needs the CSRF header of that session.
 * 5. The user's role must hold the route's permission.
 * 6. A route marked `@FreshPassword()` needs the password asked again in this session
 *    within the last 5 minutes.
 *
 * At start, every route of every controller must declare `@Permission` or `@Public`;
 * the application does not start otherwise.
 */
@Injectable()
export class AccessGuard implements CanActivate, OnModuleInit {
  private readonly origins: Readonly<Record<'admin' | 'public', string>>;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly reflector: Reflector,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly sessions: SessionService,
    private readonly context: TenantContext,
  ) {
    this.origins = { admin: config.origins.admin, public: config.origins.public };
  }

  /** Stops the start when a route declares neither a permission nor that it is public. */
  onModuleInit(): void {
    const undeclared: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype;
      const instance = wrapper.instance as object | undefined;
      if (typeof controller !== 'function' || instance === undefined) {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name];
        if (
          typeof handler !== 'function' ||
          (Reflect.getMetadata(METHOD_METADATA, handler) === undefined &&
            Reflect.getMetadata(PATH_METADATA, handler) === undefined)
        ) {
          continue;
        }
        const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS_METADATA, [
          handler,
          controller,
        ]);
        if (access === undefined) {
          undeclared.push(`${controller.name}.${name}`);
        }
      }
    }
    if (undeclared.length > 0) {
      throw new Error(
        `Routes without @Permission or @Public (ADR-05: guards deny by default): ${undeclared.join(', ')}.`,
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS_METADATA, [
      handler,
      controller,
    ]);
    if (access === undefined) {
      throw new ProblemException(404, 'not_found');
    }
    const request = context.switchToHttp().getRequest<Request & { access?: SessionState }>();
    const changing = !READING.has(request.method);

    if (changing && !(access.kind === 'public' && access.origin === 'any')) {
      const surface = this.reflector.get<Surface | undefined>(SURFACE_KEY, controller);
      const expected =
        surface === 'admin' || surface === 'public' ? this.origins[surface] : undefined;
      if (expected === undefined || request.headers.origin !== expected) {
        throw new ProblemException(403, 'origin_refused');
      }
    }
    if (access.kind === 'public') {
      return true;
    }

    const token = cookieValue(request, SESSION_COOKIE);
    const state =
      token === null
        ? null
        : await this.sessions.authenticate(token, {
            renew: request.headers[BACKGROUND_HEADER] === undefined,
          });
    if (state === null) {
      throw new ProblemException(401, 'unauthenticated');
    }
    if (changing) {
      const given = request.headers[CSRF_HEADER];
      if (typeof given !== 'string' || !sameText(given, csrfValueOf(state.sessionToken))) {
        throw new ProblemException(403, 'csrf_refused');
      }
    }
    if (!state.permissions.has(access.permission)) {
      throw new ProblemException(403, 'forbidden');
    }
    const fresh = this.reflector.get<boolean | undefined>(FRESH_PASSWORD_KEY, handler) === true;
    if (fresh && state.confirmationValidUntil === null) {
      throw new ProblemException(403, 'password_confirmation_required');
    }
    this.context.enter(state.organisationId);
    request.access = state;
    return true;
  }
}
