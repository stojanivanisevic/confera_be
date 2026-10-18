import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

/**
 * The mail outbox, as far as 0.2.0 part A needs it (ADR-13): a message is queued in the
 * SAME transaction as the change that causes it, with a unique key, one recipient per row.
 * A link is never stored: the row says which link the message carries (its purpose and
 * the user), and the worker of part B makes the link when it sends, renders the template
 * and sends through the organisation's mail server. Until then the rows wait.
 */
export const MAIL_KINDS = [
  /** An invitation to set a password (FR-USR-02); carries an invitation link. */
  'invitation',
  /** A password reset (FR-USR-03); carries a reset link. */
  'password_reset',
  /** To the new address of an email change; carries its confirmation link. */
  'email_change_confirmation',
  /** To the old address of an email change: it was asked for (ADR-03). */
  'email_change_notice',
  /** To every active admin: a sensitive change, or a sign-in from a new device (ADR-03, ST-19). */
  'security_notice',
  /** To the owner of an account that the brake slows down; at most one a day (ADR-03). */
  'sign_in_brake',
  /** The test message of a mail server (FR-SMTP-01); sent at once, not by the worker. */
  'test_message',
  /**
   * To the corresponding author of a submission (FR-FORM-15 as amended by SA-13): fixed
   * text, the reference and the title only. Counted by the send breaker (ADR-08).
   */
  'submission_confirmation',
] as const;

export type MailKind = (typeof MAIL_KINDS)[number];

/** What a security notice to the admins is about. */
export type SecurityChange =
  | 'user_invited'
  | 'user_changed'
  | 'user_role_changed'
  | 'user_deactivated'
  | 'user_reactivated'
  | 'user_removed'
  | 'user_sessions_ended'
  | 'own_password_changed'
  | 'password_reset'
  | 'own_email_change_requested'
  | 'organisation_payment_details_changed'
  | 'new_device_sign_in'
  | 'mail_server_created'
  | 'mail_server_changed'
  | 'mail_server_deleted'
  /** The send breaker holds confirmation emails (ADR-08, M3-BE-09): at most one notice an hour per form. */
  | 'mail_held'
  /** The unattached uploads reached their quota (ADR-10): uploads are refused. */
  | 'upload_quota_reached'
  /** Files wait for their virus scan because ClamAV does not answer (ADR-10, fail closed). */
  | 'virus_scan_pending';

/** Why the send breaker holds a message (ADR-08). */
export type HeldReason = 'send_breaker_form' | 'send_breaker_organisation' | 'recipient_domain';

/**
 * A hold with its numbers (UX3-06): `count` in the last `windowHours` hours, this message
 * included, went above `limit`.
 */
export interface Hold {
  readonly reason: HeldReason;
  readonly count: number;
  readonly limit: number;
  readonly windowHours: 1 | 24;
}

export interface QueuedMessage {
  readonly organisationId: string;
  readonly kind: MailKind;
  readonly recipientUserId?: string | null;
  readonly recipientAddress: string;
  readonly linkPurpose?: 'invitation' | 'password_reset' | 'email_change';
  readonly linkUserId?: string;
  /** Ids and fixed codes only: never a token, never a value a person typed. */
  readonly parameters?: Readonly<Record<string, string | number | boolean | null>>;
  /** Makes the queueing idempotent: the same key is queued once. */
  readonly uniqueKey: string;
  /** The language of the recipient, en or sr. Default en. */
  readonly language?: 'en' | 'sr';
  /** The conference the message is about: it chooses the templates and the mail server. */
  readonly conferenceId?: string | null;
  /** The form and submission of a confirmation, for the send breaker and the detail view. */
  readonly formId?: string | null;
  readonly submissionId?: string | null;
  /** When set, the message is held for an admin (the send breaker) instead of queued. */
  readonly held?: Hold | null;
}

@Injectable()
export class MailQueue {
  async enqueue(tx: Prisma.TransactionClient, message: QueuedMessage): Promise<void> {
    await tx.mailMessage.upsert({
      where: {
        organisationId_uniqueKey: {
          organisationId: message.organisationId,
          uniqueKey: message.uniqueKey,
        },
      },
      update: {},
      create: {
        organisationId: message.organisationId,
        uniqueKey: message.uniqueKey,
        kind: message.kind,
        recipientUserId: message.recipientUserId ?? null,
        recipientAddress: message.recipientAddress,
        linkPurpose: message.linkPurpose ?? null,
        linkUserId: message.linkUserId ?? null,
        parameters: message.parameters ?? {},
        language: message.language ?? 'en',
        conferenceId: message.conferenceId ?? null,
        formId: message.formId ?? null,
        submissionId: message.submissionId ?? null,
        status: message.held === undefined || message.held === null ? 'queued' : 'held',
        heldReason: message.held?.reason ?? null,
        heldCount: message.held?.count ?? null,
        heldLimit: message.held?.limit ?? null,
        heldWindowHours: message.held?.windowHours ?? null,
      },
    });
  }

  /**
   * A notice to every active admin of the organisation (ADR-03: "Every such change, and a
   * sign-in from a new device, sends an email to all active admins"), one message each.
   */
  async noticeToAdmins(
    tx: Prisma.TransactionClient,
    organisationId: string,
    change: SecurityChange,
    parameters: Readonly<Record<string, string | null>> = {},
    /** An event of its own name is told once: an alert repeated within its hour is one notice. */
    eventKey?: string,
  ): Promise<number> {
    const admins = await tx.user.findMany({
      where: { organisationId, status: 'active', roles: { some: { role: 'admin' } } },
      select: { id: true, email: true },
    });
    const event = eventKey ?? randomUUID();
    for (const admin of admins) {
      await this.enqueue(tx, {
        organisationId,
        kind: 'security_notice',
        recipientUserId: admin.id,
        recipientAddress: admin.email,
        parameters: { change, ...parameters },
        uniqueKey: `security_notice:${event}:${admin.id}`,
      });
    }
    return admins.length;
  }

  /**
   * Ends every message of a user that would still make a link (SEC-M2-01): queued, waiting
   * for a server or retrying. Called in the transaction of a change of the password or the
   * address, after which no request made before it may produce a working link.
   */
  async supersedeLinks(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const ended = await tx.mailMessage.updateMany({
      where: {
        linkUserId: userId,
        linkPurpose: { not: null },
        status: { in: ['queued', 'waiting_for_server'] },
      },
      data: { status: 'failed', lastErrorCode: 'superseded', claimedAt: null },
    });
    return ended.count;
  }

  /** How many messages of a kind went to a user since a moment: for cool-downs and caps. */
  countSince(
    tx: Prisma.TransactionClient,
    recipientUserId: string,
    kind: MailKind,
    since: Date,
  ): Promise<number> {
    return tx.mailMessage.count({
      where: { recipientUserId, kind, createdAt: { gt: since } },
    });
  }
}
