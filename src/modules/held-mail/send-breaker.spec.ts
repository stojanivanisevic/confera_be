import type { Prisma } from '../../generated/prisma/client';
import { heldNumbersOf, SendBreaker } from './send-breaker';

/**
 * The send breaker's numbers (UX3-06): which limit held a confirmation, the count it made and
 * the window, so that the office reads "4 in 1 hour, limit 3".
 */
describe('the send breaker', () => {
  const now = new Date('2026-10-18T12:00:00Z');

  /** A transaction whose counts answer by scope (form or organisation) and window (hour or day). */
  function tx(counts: {
    formHour: number;
    formDay: number;
    orgHour: number;
    orgDay: number;
    domain: number;
  }) {
    const hourAgo = now.getTime() - 60 * 60_000;
    return {
      mailMessage: {
        count: ({ where }: { where: { formId?: string; createdAt: { gt: Date } } }) => {
          const hour = where.createdAt.gt.getTime() === hourAgo;
          const value =
            where.formId === undefined
              ? hour
                ? counts.orgHour
                : counts.orgDay
              : hour
                ? counts.formHour
                : counts.formDay;
          return Promise.resolve(value);
        },
      },
      submission: { count: () => Promise.resolve(counts.domain) },
    } as unknown as Prisma.TransactionClient;
  }

  const decide = (counts: Parameters<typeof tx>[0]) =>
    new SendBreaker().decide(tx(counts), {
      formId: 'form',
      form: { perHour: 3, perDay: 50 },
      organisation: { perHour: 30, perDay: 200 },
      domain: 'a.example.test',
      now,
    });

  it('names the limit, the count with this confirmation, and the window', async () => {
    expect(await decide({ formHour: 2, formDay: 2, orgHour: 2, orgDay: 2, domain: 1 })).toBeNull();
    expect(await decide({ formHour: 3, formDay: 3, orgHour: 3, orgDay: 3, domain: 1 })).toEqual({
      reason: 'send_breaker_form',
      count: 4,
      limit: 3,
      windowHours: 1,
    });
    expect(await decide({ formHour: 0, formDay: 50, orgHour: 0, orgDay: 50, domain: 1 })).toEqual({
      reason: 'send_breaker_form',
      count: 51,
      limit: 50,
      windowHours: 24,
    });
    expect(await decide({ formHour: 0, formDay: 0, orgHour: 30, orgDay: 30, domain: 1 })).toEqual({
      reason: 'send_breaker_organisation',
      count: 31,
      limit: 30,
      windowHours: 1,
    });
    expect(await decide({ formHour: 0, formDay: 0, orgHour: 0, orgDay: 0, domain: 101 })).toEqual({
      reason: 'recipient_domain',
      count: 101,
      limit: 100,
      windowHours: 24,
    });
  });

  it('gives no numbers for a message held before they were kept', () => {
    expect(heldNumbersOf({ heldCount: null, heldLimit: null, heldWindowHours: null })).toBeNull();
    expect(heldNumbersOf({ heldCount: 4, heldLimit: 3, heldWindowHours: 1 })).toEqual({
      count: 4,
      limit: 3,
      windowHours: 1,
    });
  });
});
