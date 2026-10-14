import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { SystemResolvers } from '../../platform/prisma/system/resolvers';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { digestOf, isToken, newToken } from '../access/tokens';

/**
 * Secure links (ADR-04, SEC-A-14, SEC-A-15; ST-15, ST-17).
 *
 * - A token of 32 random bytes in the path of the link; only its SHA-256 is stored, with
 *   the purpose, the user (subject), the recipient, the expiry, and the times it was used
 *   and revoked.
 * - Every endpoint accepts exactly one purpose: a token of another purpose is not found.
 * - Opening a link only shows; the action is a POST that uses the link up atomically.
 * - A newer link revokes the older ones of the same purpose, user and recipient, and only
 *   those.
 * - A link exists only in the email that carries it: the outbox says which link a message
 *   needs, and the sender makes it (`mint`) when it sends (0.2.0 part B).
 */
export type LinkPurpose = 'invitation' | 'password_reset' | 'email_change';

/** Lifetimes (P, ADR-04): reset and email change 30 minutes, invitation 72 hours. */
export const LINK_LIFETIME_MS: Readonly<Record<LinkPurpose, number>> = {
  invitation: 72 * 60 * 60 * 1000,
  password_reset: 30 * 60 * 1000,
  email_change: 30 * 60 * 1000,
};

export interface OpenLink {
  readonly id: string;
  readonly organisationId: string;
  readonly purpose: LinkPurpose;
  readonly userId: string;
  readonly recipient: string;
  readonly expiresAt: Date;
}

@Injectable()
export class SecureLinks {
  constructor(
    private readonly database: TenantDatabase,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
  ) {}

  /**
   * Makes a link and returns its token, which goes into the email and nowhere else. Revokes
   * the older open links of the same purpose, user and recipient. Inside the organisation.
   */
  async mint(
    tx: Prisma.TransactionClient,
    link: { organisationId: string; purpose: LinkPurpose; userId: string; recipient: string },
    now = new Date(),
  ): Promise<string> {
    await tx.secureLink.updateMany({
      where: {
        purpose: link.purpose,
        userId: link.userId,
        recipient: link.recipient,
        usedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    const token = newToken();
    await tx.secureLink.create({
      data: {
        organisationId: link.organisationId,
        purpose: link.purpose,
        tokenHash: digestOf(token),
        userId: link.userId,
        recipient: link.recipient,
        createdAt: now,
        expiresAt: new Date(now.getTime() + LINK_LIFETIME_MS[link.purpose]),
      },
    });
    return token;
  }

  /**
   * The open link of a token for exactly this purpose, or null: unknown, of another
   * purpose, used, revoked or expired all look the same. Changes nothing.
   */
  async open(token: string, purpose: LinkPurpose, now = new Date()): Promise<OpenLink | null> {
    if (!isToken(token)) {
      return null;
    }
    const found = await this.resolvers.linkByTokenHash(digestOf(token));
    if (found === null) {
      return null;
    }
    return this.context.run(found.organisationId, async () => {
      const link = await this.database.db.secureLink.findUnique({ where: { id: found.linkId } });
      if (link === null) {
        return null;
      }
      if (
        link.purpose !== purpose ||
        link.usedAt !== null ||
        link.revokedAt !== null ||
        link.expiresAt.getTime() <= now.getTime()
      ) {
        return null;
      }
      return {
        id: link.id,
        organisationId: link.organisationId,
        purpose,
        userId: link.userId,
        recipient: link.recipient,
        expiresAt: link.expiresAt,
      };
    });
  }

  /**
   * Uses a link up, atomically: true for the one request that did, false for every other
   * (used, revoked, expired meanwhile). Inside the transaction of the action.
   */
  async consume(tx: Prisma.TransactionClient, link: OpenLink, now = new Date()): Promise<boolean> {
    const result = await tx.secureLink.updateMany({
      where: {
        id: link.id,
        purpose: link.purpose,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    return result.count === 1;
  }

  /** Revokes every open link of a user, of the purposes given (all when none). */
  async revokeAll(
    tx: Prisma.TransactionClient,
    userId: string,
    purposes?: readonly LinkPurpose[],
    now = new Date(),
  ): Promise<number> {
    const result = await tx.secureLink.updateMany({
      where: {
        userId,
        usedAt: null,
        revokedAt: null,
        ...(purposes === undefined ? {} : { purpose: { in: [...purposes] } }),
      },
      data: { revokedAt: now },
    });
    return result.count;
  }
}
