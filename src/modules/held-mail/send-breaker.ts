import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { HeldReason } from '../mail/mail-queue';

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
  /** Whether the confirmation of a new submission is held, and why; null: it goes out. */
  async decide(
    tx: Prisma.TransactionClient,
    input: {
      readonly formId: string;
      readonly form: BreakerLimits;
      readonly organisation: BreakerLimits;
      readonly domain: string;
      readonly now: Date;
    },
  ): Promise<HeldReason | null> {
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
    if (formHour >= input.form.perHour || formDay >= input.form.perDay) {
      return 'send_breaker_form';
    }
    if (
      organisationHour >= input.organisation.perHour ||
      organisationDay >= input.organisation.perDay
    ) {
      return 'send_breaker_organisation';
    }
    const toDomain = await tx.submission.count({
      where: { correspondingDomain: input.domain, receivedAt: { gt: dayAgo } },
    });
    if (toDomain >= DOMAIN_DAILY_LIMIT) {
      return 'recipient_domain';
    }
    return null;
  }
}
