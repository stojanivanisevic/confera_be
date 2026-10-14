import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { SystemResolvers } from '../../platform/prisma/system/resolvers';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import type { Access } from './access';
import { isPermission, isRole, type PermissionName, type RoleName } from './permissions';
import { digestOf, newToken } from './tokens';

/**
 * Sessions (ADR-03, SEC-A-15, SEC-A-44; ST-14, ST-61).
 *
 * - The cookie holds a random token; the table only its SHA-256. A new token at every
 *   sign-in.
 * - A session ends 24 hours after its last use, and at the latest 7 days after sign-in
 *   (G2-24). Use renews it, a request marked as a background refetch does not. Expiry is
 *   decided here, on the server.
 * - The password asked again (`@FreshPassword`) is valid for 5 minutes, in that session only.
 * - The model is ready for the second factor of 0.9.0 (G2-16): a session whose second
 *   factor is `pending` is not signed in yet.
 * - Every ending event of ADR-03 ends sessions here, with its reason.
 */
export const IDLE_MS = 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const FRESH_PASSWORD_MS = 5 * 60 * 1000;

/** A renewal is written at most once a minute, not on every request. */
const RENEW_AFTER_MS = 60 * 1000;

export type EndReason =
  | 'signed_out'
  | 'signed_out_everywhere'
  | 'expired'
  | 'signed_in_again'
  | 'password_changed'
  | 'password_reset'
  | 'email_changed'
  | 'role_changed'
  | 'deactivated'
  | 'removed'
  | 'ended_by_admin'
  | 'global_revoke'
  | 'not_active';

export interface SessionState extends Access {
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  /** Until when the password asked again is valid; null when it was not asked. */
  readonly confirmationValidUntil: Date | null;
  readonly secondFactor: 'not_required' | 'pending' | 'passed';
}

export interface NewSession {
  readonly token: string;
  readonly sessionId: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
  ) {}

  /** Opens a session for a user, inside the transaction of the sign-in. */
  async create(
    tx: Prisma.TransactionClient,
    user: { organisationId: string; userId: string },
    deviceId: string | null,
    now = new Date(),
  ): Promise<NewSession> {
    const token = newToken();
    const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_MS);
    const session = await tx.session.create({
      data: {
        organisationId: user.organisationId,
        userId: user.userId,
        tokenHash: digestOf(token),
        deviceId,
        createdAt: now,
        lastUsedAt: now,
        idleExpiresAt: new Date(Math.min(now.getTime() + IDLE_MS, absoluteExpiresAt.getTime())),
        absoluteExpiresAt,
      },
      select: { id: true },
    });
    return { token, sessionId: session.id };
  }

  /** The organisation and id of the session of a token, or null. Through the resolver of ADR-05. */
  async find(token: string): Promise<{ organisationId: string; sessionId: string } | null> {
    return this.resolvers.sessionByTokenHash(digestOf(token));
  }

  /**
   * The signed-in user of a token, or null when the session does not exist, has ended or
   * expired, or its user is no longer active. An expired session is ended here. `renew`:
   * the request is a use of the session (not a background refetch).
   */
  async authenticate(
    token: string,
    options: { renew: boolean },
    now = new Date(),
  ): Promise<SessionState | null> {
    const found = await this.find(token);
    if (found === null) {
      return null;
    }
    return this.context.run(found.organisationId, () =>
      this.database.transaction(async (tx) => {
        const session = await tx.session.findUnique({
          where: { id: found.sessionId },
          include: {
            user: {
              select: {
                status: true,
                roles: {
                  select: {
                    role: true,
                    roleRef: { select: { permissions: { select: { permission: true } } } },
                  },
                },
              },
            },
          },
        });
        if (session === null) {
          return null;
        }
        if (session.tokenHash !== digestOf(token) || session.endedAt !== null) {
          return null;
        }
        const time = now.getTime();
        if (
          time >= session.idleExpiresAt.getTime() ||
          time >= session.absoluteExpiresAt.getTime()
        ) {
          await this.endWhere(tx, { id: session.id }, 'expired', now);
          return null;
        }
        if (session.user.status !== 'active') {
          await this.endWhere(tx, { id: session.id }, 'not_active', now);
          return null;
        }
        if (session.secondFactor === 'pending') {
          return null;
        }
        let idleExpiresAt = session.idleExpiresAt;
        if (options.renew && time - session.lastUsedAt.getTime() >= RENEW_AFTER_MS) {
          idleExpiresAt = new Date(Math.min(time + IDLE_MS, session.absoluteExpiresAt.getTime()));
          await tx.session.update({
            where: { id: session.id },
            data: { lastUsedAt: now, idleExpiresAt },
          });
        }
        const roles: RoleName[] = session.user.roles.map(({ role }) => role).filter(isRole);
        const permissions = new Set<PermissionName>(
          session.user.roles
            .flatMap(({ roleRef }) => roleRef.permissions.map(({ permission }) => permission))
            .filter(isPermission),
        );
        const confirmed = session.passwordConfirmedAt;
        const confirmationValidUntil =
          confirmed === null ? null : new Date(confirmed.getTime() + FRESH_PASSWORD_MS);
        return {
          sessionId: session.id,
          userId: session.userId,
          organisationId: session.organisationId,
          roles,
          permissions,
          sessionToken: token,
          idleExpiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
          confirmationValidUntil:
            confirmationValidUntil !== null && confirmationValidUntil.getTime() > time
              ? confirmationValidUntil
              : null,
          secondFactor: session.secondFactor as SessionState['secondFactor'],
        };
      }),
    );
  }

  /** The password was asked again in this session, and given right. */
  async confirmPassword(tx: Prisma.TransactionClient, sessionId: string, now = new Date()) {
    await tx.session.update({ where: { id: sessionId }, data: { passwordConfirmedAt: now } });
    return new Date(now.getTime() + FRESH_PASSWORD_MS);
  }

  /** Ends one session. */
  end(tx: Prisma.TransactionClient, sessionId: string, reason: EndReason): Promise<number> {
    return this.endWhere(tx, { id: sessionId }, reason);
  }

  /** Ends every open session of a user; `except` keeps one (the own password change). */
  endAllOf(
    tx: Prisma.TransactionClient,
    userId: string,
    reason: EndReason,
    except?: string,
  ): Promise<number> {
    return this.endWhere(
      tx,
      except === undefined ? { userId } : { userId, id: { not: except } },
      reason,
    );
  }

  private async endWhere(
    tx: Prisma.TransactionClient,
    where: Prisma.SessionWhereInput,
    reason: EndReason,
    now = new Date(),
  ): Promise<number> {
    const result = await tx.session.updateMany({
      where: { ...where, endedAt: null },
      data: { endedAt: now, endReason: reason },
    });
    return result.count;
  }
}
