import type { PermissionName, RoleName } from './permissions';

/** The signed-in user of a request, as the access guard found it (ADR-03, ADR-05). */
export interface Access {
  readonly sessionId: string;
  readonly userId: string;
  readonly organisationId: string;
  readonly roles: readonly RoleName[];
  readonly permissions: ReadonlySet<PermissionName>;
  /** The token of the session cookie: the key of the CSRF value. Never logged, never returned. */
  readonly sessionToken: string;
}
