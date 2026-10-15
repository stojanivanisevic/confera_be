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

export interface ResolvedSession {
  readonly organisationId: string;
  readonly sessionId: string;
}

export interface ResolvedLink {
  readonly organisationId: string;
  readonly linkId: string;
}

export interface ResolvedMessage {
  readonly organisationId: string;
  readonly messageId: string;
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
 *   - session by hash, secure link by hash          (sessionByTokenHash, linkByTokenHash)
 *   - the organisations a job loops over            (organisationsWithUsers)
 *   - form by public key, a form's site list                      (0.3.0)
 *   - PayPal order by order id                                    (0.7.0)
 *   - the claim of a job or outbox row                            (outboxDue)
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

  /**
   * Finds a session by the SHA-256 of the token in its cookie (ADR-03). Whether it is still
   * valid, and whose it is, is read afterwards through the tenant client.
   */
  async sessionByTokenHash(tokenHash: string): Promise<ResolvedSession | null> {
    const session = await this.#client.session.findUnique({
      where: { tokenHash },
      select: { id: true, organisationId: true },
    });
    return session === null
      ? null
      : { organisationId: session.organisationId, sessionId: session.id };
  }

  /** Finds a secure link by the SHA-256 of its token (ADR-04). Its purpose and state are read afterwards. */
  async linkByTokenHash(tokenHash: string): Promise<ResolvedLink | null> {
    const link = await this.#client.secureLink.findUnique({
      where: { tokenHash },
      select: { id: true, organisationId: true },
    });
    return link === null ? null : { organisationId: link.organisationId, linkId: link.id };
  }

  /**
   * The organisations that have users: what a job that works for every organisation loops
   * over (ADR-05), the summary of failed sign-ins for unknown addresses first. Ids only.
   */
  async organisationsWithUsers(): Promise<string[]> {
    const rows = await this.#client.$queryRaw<{ organisationId: string }[]>`
      SELECT DISTINCT organisation_id::text AS "organisationId" FROM users ORDER BY 1`;
    return rows.map(({ organisationId }) => organisationId);
  }

  /**
   * The outbox rows the worker looks at now (ADR-05, ADR-13): `due` are queued and due,
   * oldest first; `stale` were left in `sending` before `staleBefore` (a crash), to be
   * flagged and never sent again by themselves. Ids only; the worker claims and reads each
   * row afterwards inside its organisation.
   */
  async outboxDue(
    now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<{ due: ResolvedMessage[]; stale: ResolvedMessage[] }> {
    const select = { id: true, organisationId: true } as const;
    const [due, stale] = await Promise.all([
      this.#client.mailMessage.findMany({
        where: { status: 'queued', nextAttemptAt: { lte: now } },
        select,
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
      this.#client.mailMessage.findMany({
        where: { status: 'sending', claimedAt: { lt: staleBefore } },
        select,
        take: limit,
      }),
    ]);
    const ids = (rows: { id: string; organisationId: string }[]) =>
      rows.map((row) => ({ organisationId: row.organisationId, messageId: row.id }));
    return { due: ids(due), stale: ids(stale) };
  }

  /** For the start-up check only: what the system role is allowed to do. No tenant data. */
  describeRole(): Promise<DatabaseRole> {
    return within(describeRole(this.#client), START_CHECK_TIMEOUT_MS, 'the start-up role check');
  }

  async onModuleDestroy(): Promise<void> {
    await this.#client.$disconnect();
  }
}
