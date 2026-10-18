import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { Hold } from '../mail/mail-queue';

/**
 * The send breaker (ADR-08, item 3; M3-BE-09; ST-34): per form and per organisation, on
 * the confirmation emails of submissions. Above it the submission is still stored, its
 * confirmation is held for an admin to release, and the admins are told (at most once an
 * hour per form). A deadline day can trip it: that costs a notice and one click.
 *
 * Counted are the confirmations that went the normal way (not held) in the last hour and
 * the last 24 hours; and, against mail-bombing one domain, the submissions of the
 * organisation whose corresponding address is at that domain in the last 24 hours.
 */
export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;

/** Confirmations to one recipient domain in 24 hours, per organisation, before they are held (P). */
export const DOMAIN_DAILY_LIMIT = 100;

export interface BreakerLimits {
  readonly perHour: number;
  readonly perDay: number;
}

@Injectable()
export class SendBreaker {
  /** Whether the confirmation of a new submission is held, why and by which numbers; null: it goes out. */
  async decide(
    tx: Prisma.TransactionClient,
    input: {
      readonly formId: string;
      readonly form: BreakerLimits;
      readonly organisation: BreakerLimits;
      readonly domain: string;
      readonly now: Date;
    },
  ): Promise<Hold | null> {
    const hourAgo = new Date(input.now.getTime() - HOUR_MS);
    const dayAgo = new Date(input.now.getTime() - DAY_MS);
    const sent = (where: Prisma.MailMessageWhereInput, since: Date) =>
      tx.mailMessage.count({
        where: {
          ...where,
          kind: 'submission_confirmation',
          heldReason: null,
          createdAt: { gt: since },
        },
      });
    const [formHour, formDay, organisationHour, organisationDay] = await Promise.all([
      sent({ formId: input.formId }, hourAgo),
      sent({ formId: input.formId }, dayAgo),
      sent({}, hourAgo),
      sent({}, dayAgo),
    ]);
    // The counts are of the confirmations that went out; with this one each is one more.
    const form = over(formHour, formDay, input.form);
    if (form !== null) {
      return { reason: 'send_breaker_form', ...form };
    }
    const organisation = over(organisationHour, organisationDay, input.organisation);
    if (organisation !== null) {
      return { reason: 'send_breaker_organisation', ...organisation };
    }
    const toDomain = await tx.submission.count({
      where: { correspondingDomain: input.domain, receivedAt: { gt: dayAgo } },
    });
    // The count holds the submission at hand: the 101st to a domain is held, not the 100th (Q3-06).
    if (toDomain > DOMAIN_DAILY_LIMIT) {
      return {
        reason: 'recipient_domain',
        count: toDomain,
        limit: DOMAIN_DAILY_LIMIT,
        windowHours: 24,
      };
    }
    return null;
  }
}

/** The limit a confirmation would go above, the hour's first, with the count this one makes. */
function over(
  hour: number,
  day: number,
  limits: BreakerLimits,
): { count: number; limit: number; windowHours: 1 | 24 } | null {
  if (hour >= limits.perHour) {
    return { count: hour + 1, limit: limits.perHour, windowHours: 1 };
  }
  if (day >= limits.perDay) {
    return { count: day + 1, limit: limits.perDay, windowHours: 24 };
  }
  return null;
}

/** The numbers of a held message as the API gives them (UX3-06); null when none were kept. */
export function heldNumbersOf(row: {
  readonly heldCount: number | null;
  readonly heldLimit: number | null;
  readonly heldWindowHours: number | null;
}): { count: number; limit: number; windowHours: 1 | 24 } | null {
  if (row.heldCount === null || row.heldLimit === null || row.heldWindowHours === null) {
    return null;
  }
  return {
    count: row.heldCount,
    limit: row.heldLimit,
    windowHours: row.heldWindowHours === 1 ? 1 : 24,
  };
}
