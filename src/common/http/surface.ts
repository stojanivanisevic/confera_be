import {
  applyDecorators,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
  SetMetadata,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import { parseHostHeader } from './host-header';

/**
 * The two surfaces of Confera (ADR-02, finding SEC-A-50, test ST-66).
 *
 * - `admin`:  /api/v1/...     answers only under the host name of ADMIN_ORIGIN
 * - `public`: /public/v1/...  answers only under the host name of PUBLIC_ORIGIN
 * - `ops`:    health and the like, outside both APIs, under any host name
 *
 * The separation is enforced here, in the application, and not only in the proxy: a
 * request for a route under the other host name is answered "not found", exactly like a
 * route that does not exist.
 *
 * A controller declares its surface by the decorator it uses instead of `@Controller`.
 * The application refuses to start when a controller declares none.
 */
export type Surface = 'admin' | 'public' | 'ops';

export const SURFACE_KEY = 'confera:surface';

export const SURFACE_PREFIX = {
  admin: 'api/v1',
  public: 'public/v1',
} as const;

/** A controller of the admin API: `/api/v1/<path>`, admin host only. */
export function AdminController(path: string): ClassDecorator {
  return applyDecorators(
    Controller(`${SURFACE_PREFIX.admin}/${path}`),
    SetMetadata(SURFACE_KEY, 'admin' satisfies Surface),
  );
}

/** A controller of the public API: `/public/v1/<path>`, public host only. */
export function PublicController(path: string): ClassDecorator {
  return applyDecorators(
    Controller(`${SURFACE_PREFIX.public}/${path}`),
    SetMetadata(SURFACE_KEY, 'public' satisfies Surface),
  );
}

/** A controller outside both APIs (health). Any host; left out of the OpenAPI documents. */
export function OpsController(path: string): ClassDecorator {
  return applyDecorators(
    Controller(path),
    SetMetadata(SURFACE_KEY, 'ops' satisfies Surface),
    ApiExcludeController(),
  );
}

/**
 * Host name of a Host header, without the port and in lower case. Empty when the header
 * is missing or is not a host: such a request belongs to no surface.
 */
export function hostnameOf(hostHeader: string | undefined): string {
  return parseHostHeader(hostHeader)?.hostname ?? '';
}

function violatesPrefix(surface: Surface, path: string): boolean {
  const normalised = path.replace(/^\/+/, '');
  const underAdmin =
    normalised === SURFACE_PREFIX.admin || normalised.startsWith(`${SURFACE_PREFIX.admin}/`);
  const underPublic =
    normalised === SURFACE_PREFIX.public || normalised.startsWith(`${SURFACE_PREFIX.public}/`);
  if (surface === 'admin') {
    return !underAdmin;
  }
  if (surface === 'public') {
    return !underPublic;
  }
  // An ops controller must not sit inside either API, nor anywhere near them.
  return /^(api|public)(\/|$)/.test(normalised);
}

@Injectable()
export class SurfaceGuard implements CanActivate, OnModuleInit {
  private readonly hosts: Readonly<Record<'admin' | 'public', string>>;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly reflector: Reflector,
    private readonly discovery: DiscoveryService,
  ) {
    this.hosts = {
      admin: new URL(config.origins.admin).hostname.toLowerCase(),
      public: new URL(config.origins.public).hostname.toLowerCase(),
    };
  }

  /** Stops the start when a controller declares no surface, or sits under the wrong path. */
  onModuleInit(): void {
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') {
        continue;
      }
      const surface = this.reflector.get<Surface | undefined>(SURFACE_KEY, controller);
      if (surface === undefined) {
        throw new Error(
          `Controller ${controller.name} declares no surface: use AdminController, PublicController or OpsController instead of Controller (ADR-02).`,
        );
      }
      const paths = [
        this.reflector.get<string | string[] | undefined>(PATH_METADATA, controller) ?? '',
      ].flat();
      for (const path of paths) {
        if (violatesPrefix(surface, path)) {
          throw new Error(
            `Controller ${controller.name} is on the ${surface} surface but its path "${path}" does not belong there (ADR-02).`,
          );
        }
      }
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const surface = this.reflector.get<Surface | undefined>(SURFACE_KEY, context.getClass());
    if (surface === 'ops') {
      return true;
    }
    const host = hostnameOf(context.switchToHttp().getRequest<Request>().headers.host);
    if (
      (surface === 'admin' || surface === 'public') &&
      host !== '' &&
      host === this.hosts[surface]
    ) {
      return true;
    }
    throw new NotFoundException();
  }
}
