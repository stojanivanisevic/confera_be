import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '../../../config/config';
import { APP_CONFIG } from '../../../config/config.module';
import type { PrismaClient } from '../../../generated/prisma/client';
import { type DatabaseRole, describeRole } from '../database-role';
import { START_CHECK_TIMEOUT_MS, within } from '../tenant-client';
import { createSystemClient } from './system-client';

/** What a resolver returns: which organisation, and which record in it. Never more. */
export interface ResolvedUser {
  readonly organisationId: string;
  readonly userId: string;
}

/**
 * The resolvers: the only code that uses the system role (ADR-05, finding SEC-A-11).
 *
 * A resolver answers one question, "which organisation does this belong to?", for the
 * moments when a request arrives and no organisation is known yet. It returns an
 * organisation id and a record id and nothing else; everything after that runs through
 * the tenant client inside the resolved organisation, under row-level security.
 *
 * The complete list of the ADR, of which the ones that exist so far are implemented:
 *   - user by email, at sign-in and at a password-reset request   (userByEmail)
 *   - session by hash, secure link by hash                        (0.2.0)
 *   - form by public key, a form's site list                      (0.3.0)
 *   - PayPal order by order id                                    (0.7.0)
 *   - the claim of a job or outbox row                            (0.2.0)
 *
 * An architecture test asserts that this class has no other public member than the
 * resolvers on that list, and that every resolver returns ids only.
 */
@Injectable()
export class SystemResolvers implements OnModuleDestroy {
  readonly #client: PrismaClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.#client = createSystemClient(config.database.systemUrl.reveal());
  }

  /**
   * Finds a user by email address, for sign-in and for a password-reset request.
   * The database grants the system role only the three columns used here; the password
   * hash is read afterwards through the tenant client.
   */
  async userByEmail(email: string): Promise<ResolvedUser | null> {
    const user = await this.#client.user.findUnique({
      where: { email },
      select: { id: true, organisationId: true },
    });
    return user === null ? null : { organisationId: user.organisationId, userId: user.id };
  }

  /** For the start-up check only: what the system role is allowed to do. No tenant data. */
  describeRole(): Promise<DatabaseRole> {
    return within(describeRole(this.#client), START_CHECK_TIMEOUT_MS, 'the start-up role check');
  }

  async onModuleDestroy(): Promise<void> {
    await this.#client.$disconnect();
  }
}
