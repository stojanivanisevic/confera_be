import { Injectable } from '@nestjs/common';
import { TenantDatabase } from '../../platform/prisma/tenant-database';

/**
 * The brake of sign-in (ADR-03, SEC-A-14, ST-15): failures slow an account and an address
 * down; they never lock anything.
 *
 * - Failed sign-ins and failed password confirmations are kept as security events of the
 *   instance (90 days, ADR-29), with the client address and, when the email belongs to an
 *   account, the account.
 * - Within an hour, the first FREE failures cost nothing. After them, the next attempt is
 *   checked only when DELAY(n) has passed since the last failure: 30 seconds after the
 *   first failure beyond the free ones, doubling with each further failure, at most 15
 *   minutes. An attempt that comes too early is answered as a failure without looking at
 *   the password, and is not counted itself, so a person who keeps trying is slowed, and
 *   one attempt in every 15 minutes is always checked.
 * - Per account: 5 free failures. A browser that has signed in to the account before (its
 *   device cookie, bound to the account) is exempt from the account's brake, and from it
 *   only: so the owner signs in while another address hammers the account.
 * - Per address: 20 free failures, for every account together.
 *
 * These values are proposed (P) and settings of this file; tests read them from here.
 */
export const BRAKE = {
  windowMs: 60 * 60 * 1000,
  accountFreeFailures: 5,
  addressFreeFailures: 20,
  firstDelayMs: 30 * 1000,
  longestDelayMs: 15 * 60 * 1000,
} as const;

/** How long after the last failure the next attempt waits, after `failures` in the window. */
export function brakeDelayMs(failures: number, free: number): number {
  if (failures < free) {
    return 0;
  }
  return Math.min(BRAKE.firstDelayMs * 2 ** (failures - free), BRAKE.longestDelayMs);
}

export interface BrakeState {
  /** The address has failed so often that this attempt must wait. */
  readonly addressBraked: boolean;
  /** The account has failed so often that this attempt must wait (never for a known device). */
  readonly accountBraked: boolean;
  /** Failures of the account in the window, before this attempt. */
  readonly accountFailures: number;
}

export type SecurityEventKind = 'sign_in_failed' | 'password_confirmation_failed';

export interface Attempt {
  readonly clientAddress: string;
  readonly user: { readonly organisationId: string; readonly userId: string } | null;
  readonly knownDevice: boolean;
}

@Injectable()
export class BrakeService {
  constructor(private readonly database: TenantDatabase) {}

  async state(attempt: Attempt, now = new Date()): Promise<BrakeState> {
    const since = new Date(now.getTime() - BRAKE.windowMs);
    const userId = attempt.user?.userId;
    const events = await this.database.instance((tx) =>
      tx.securityEvent.findMany({
        where: {
          occurredAt: { gt: since },
          OR: [
            { clientAddress: attempt.clientAddress },
            ...(userId === undefined ? [] : [{ userId }]),
          ],
        },
        select: { occurredAt: true, clientAddress: true, userId: true },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    const braked = (list: { occurredAt: Date }[], free: number): boolean => {
      const last = list[0];
      return (
        last !== undefined &&
        now.getTime() - last.occurredAt.getTime() < brakeDelayMs(list.length, free)
      );
    };
    const byAddress = events.filter((event) => event.clientAddress === attempt.clientAddress);
    const byAccount = userId === undefined ? [] : events.filter((event) => event.userId === userId);
    return {
      addressBraked: braked(byAddress, BRAKE.addressFreeFailures),
      accountBraked: !attempt.knownDevice && braked(byAccount, BRAKE.accountFreeFailures),
      accountFailures: byAccount.length,
    };
  }

  async recordFailure(kind: SecurityEventKind, attempt: Attempt): Promise<void> {
    await this.database.instance((tx) =>
      tx.securityEvent.create({
        data: {
          kind,
          clientAddress: attempt.clientAddress,
          userOrganisationId: attempt.user?.organisationId ?? null,
          userId: attempt.user?.userId ?? null,
          knownDevice: attempt.knownDevice,
        },
      }),
    );
  }
}
