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
  /** Read the mail servers (never a password). */
  'mail_servers.read',
  /** Add, change, switch off, delete and test mail servers. */
  'mail_servers.manage',
  /** Read the conferences. */
  'conferences.read',
  /** Create, change, copy conferences and change their state. */
  'conferences.manage',
  /** Read the email templates and their placeholder catalogue. */
  'templates.read',
  /** Read the mail log, the content of what was sent included. */
  'mail_log.read',
  /** Read the forms of the conferences, their drafts and published versions. */
  'forms.read',
  /** Create forms, change their draft, publish them, set their send breaker. */
  'forms.manage',
  /** Read the submissions, their files included (FR-SUB-02, FR-SUB-04, FR-FILE-02). */
  'submissions.read',
  /** See the emails the send breaker holds, and release them (ADR-08, M3-FE-08). */
  'held_mail.manage',
  /** Change the status of submissions, add notes, correct their data for the author (0.4.0). */
  'submissions.manage',
  /** Edit the email templates and their images, switch status emails off (0.4.0). */
  'templates.manage',
  /** Resend an email from the mail log, and set how long the log keeps its entries (0.4.0). */
  'mail_log.manage',
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
