import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import type { Request } from 'express';
import type { PermissionName } from './permissions';
import type { Access } from './access';

/**
 * What a route declares about who may call it (ADR-05: guards deny by default). Every
 * route declares exactly one of the two, or the application does not start:
 *
 *   @Permission('users.manage')   a signed-in user whose role holds the permission
 *   @Public()                     anyone: sign-in, password reset, a secure link
 *
 * Both are written into the OpenAPI document as `x-confera-access`, from which the
 * authorisation matrix of the end-to-end tests is generated.
 */
export const ROUTE_ACCESS_METADATA = 'confera:access';

/** `@FreshPassword()`: the password was asked again in this session less than 5 minutes ago. */
export const FRESH_PASSWORD_KEY = 'confera:fresh-password';

export type RouteAccess =
  | { readonly kind: 'permission'; readonly permission: PermissionName }
  | {
      readonly kind: 'public';
      /**
       * Whose Origin a changing request may carry. `surface` (the default): exactly the
       * origin of the route's own surface. `any`: a browser's report that changes nothing
       * (the reports of the content security policy).
       */
      readonly origin: 'surface' | 'any';
    };

export function Permission(permission: PermissionName): MethodDecorator & ClassDecorator {
  const access: RouteAccess = { kind: 'permission', permission };
  return applyDecorators(
    SetMetadata(ROUTE_ACCESS_METADATA, access),
    ApiExtension('x-confera-access', { permission }),
  );
}

export function Public(options: { anyOrigin?: boolean } = {}): MethodDecorator & ClassDecorator {
  const access: RouteAccess = { kind: 'public', origin: options.anyOrigin ? 'any' : 'surface' };
  return applyDecorators(
    SetMetadata(ROUTE_ACCESS_METADATA, access),
    ApiExtension('x-confera-access', { public: true }),
  );
}

/**
 * The change is one of those of ADR-03 that ask for the password again: bank or PayPal
 * data, mail servers, users and roles. The password entry is valid for 5 minutes and only
 * in the session that made it.
 */
export function FreshPassword(): MethodDecorator {
  return applyDecorators(
    SetMetadata(FRESH_PASSWORD_KEY, true),
    ApiExtension('x-confera-fresh-password', true),
  );
}

/** The signed-in user of the request, as the access guard found it. */
export const CurrentAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Access => {
    const access = context.switchToHttp().getRequest<Request & { access?: Access }>().access;
    if (access === undefined) {
      // A route without a permission has no signed-in user: a programming error.
      throw new Error('CurrentAccess is used on a route that has no signed-in user.');
    }
    return access;
  },
);
