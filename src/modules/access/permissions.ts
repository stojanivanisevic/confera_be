/**
 * The permissions of Confera (ADR-05, FR-USR-01): code constants. A route names the one
 * it needs (`@Permission(...)`), or says that it is public (`@Public()`); a route that
 * does neither stops the start (route-access.ts).
 *
 * Which role holds which permission is a reference table seeded by migration
 * (`role_permissions`); the guard reads it from there. ROLE_PERMISSIONS below is what the
 * migrations seed, and an integration test compares the two, so that a permission added
 * here without its migration (or the other way round) fails.
 */
export const PERMISSIONS = [
  /** One's own account: password, email, sign out everywhere. Every role. */
  'account.manage',
  /** Read the users of the organisation. */
  'users.read',
  /** Invite, edit, change the role of, deactivate, reactivate and remove users. */
  'users.manage',
  /** Read the organisation profile, the payment details included. */
  'organisation.read',
  /** Change the organisation profile and its payment details. */
  'organisation.manage',
  /** Read the audit log. */
  'audit.read',
] as const;

export type PermissionName = (typeof PERMISSIONS)[number];

export const ROLES = ['admin', 'reviewer'] as const;
export type RoleName = (typeof ROLES)[number];

/** What the migrations seed into `role_permissions`. A reviewer's review permissions arrive in 0.5.0. */
export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly PermissionName[]>> = {
  admin: [...PERMISSIONS],
  reviewer: ['account.manage'],
};

export function isPermission(value: string): value is PermissionName {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function isRole(value: string): value is RoleName {
  return (ROLES as readonly string[]).includes(value);
}
