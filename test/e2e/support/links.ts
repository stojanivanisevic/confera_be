import { type LinkPurpose, SecureLinks } from '../../../src/modules/links/secure-links';
import { TenantDatabase } from '../../../src/platform/prisma/tenant-database';
import { TenantContext } from '../../../src/platform/tenancy/tenant-context';
import type { E2eApp } from './e2e-app';

/**
 * Mints a secure link the way the sender of 0.2.0 part B will, at send time: through the
 * application's own service, inside the organisation. The token goes into the email and
 * nowhere else; the tests hold it the way a recipient would.
 */
export function mintLink(
  e2e: E2eApp,
  link: { organisationId: string; purpose: LinkPurpose; userId: string; recipient: string },
): Promise<string> {
  const links = e2e.app.get(SecureLinks);
  const context = e2e.app.get(TenantContext);
  const database = e2e.app.get(TenantDatabase);
  return context.run(link.organisationId, () => database.transaction((tx) => links.mint(tx, link)));
}

/** The path of the page behind a link of a purpose. */
export function linkPath(purpose: LinkPurpose, token: string): string {
  const base = {
    invitation: '/api/v1/invitations',
    password_reset: '/api/v1/password-resets',
    email_change: '/api/v1/email-changes',
  }[purpose];
  return `${base}/${token}`;
}
