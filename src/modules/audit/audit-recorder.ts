import { Injectable } from '@nestjs/common';
import { currentTraceId } from '../../common/http/trace';
import type { Prisma } from '../../generated/prisma/client';
import { valuesMayBeRecorded } from './audit-fields';

/**
 * The actions the audit log records so far (FR-AUD-01, as amended by SA-18). Each module
 * adds its own; the list is the set of codes an admin can filter by.
 */
export const AUDIT_ACTIONS = [
  'session.signed_in',
  'session.sign_in_failed',
  'session.signed_out',
  'session.signed_out_everywhere',
  'account.password_changed',
  'account.email_change_requested',
  'account.email_changed',
  'password_reset.requested',
  'password_reset.completed',
  'invitation.queued',
  'invitation.accepted',
  'user.invited',
  'user.updated',
  'user.role_changed',
  'user.deactivated',
  'user.reactivated',
  'user.removed',
  'user.sessions_ended',
  'organisation.updated',
  'organisation.payment_details_changed',
  'security.unknown_address_sign_ins',
  'mail_server.created',
  'mail_server.updated',
  'mail_server.deleted',
  'mail_server.tested',
  'conference.created',
  'conference.updated',
  'conference.state_changed',
  'conference.copied',
  'conference.deadline_changed',
  'form.created',
  'form.draft_changed',
  'form.published',
  'form.breaker_changed',
  'held_mail.released',
  'held_mail.discarded',
  'organisation.breaker_changed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Old and new value of a field that changed. */
export interface FieldChange {
  readonly old: string | null;
  readonly new: string | null;
}

/** Counts and periods of a summary. Never a personal value. */
export interface AuditDetail {
  readonly count?: number;
  readonly from?: string;
  readonly to?: string;
  readonly newDevice?: boolean;
}

export interface AuditRecord {
  readonly organisationId: string;
  /** Who did it; null for the system (a summary) or an unknown person (a failed sign-in). */
  readonly actorUserId: string | null;
  readonly action: AuditAction;
  readonly subjectType: string;
  readonly subjectId?: string | null;
  /** Every field that changed. Values are kept only for the fields of AUDIT_VALUE_FIELDS. */
  readonly changes?: Readonly<Record<string, FieldChange>>;
  readonly detail?: AuditDetail;
}

/** What the recorder writes for the changes of a subject: the names, and the values it may keep. */
export function auditedChanges(
  subjectType: string,
  changes: Readonly<Record<string, FieldChange>>,
): { fields: string[]; values: Record<string, FieldChange> } {
  const fields = Object.keys(changes).sort();
  const values: Record<string, FieldChange> = {};
  for (const field of fields) {
    const change = changes[field];
    if (change !== undefined && valuesMayBeRecorded(subjectType, field)) {
      values[field] = { old: change.old, new: change.new };
    }
  }
  return { fields, values };
}

/**
 * The audit log (ADR-06, FR-AUD-01 to 03): one entry per action, written in the SAME
 * transaction as the action. Insert-only: the run-time roles may read and add rows, never
 * change or delete one (ST-24). An entry holds who, when, what and which fields changed,
 * with references; old and new values only for the fields on the list in code, so no
 * personal value, password, token or file content ever reaches it (FR-AUD-03).
 */
@Injectable()
export class AuditRecorder {
  async record(tx: Prisma.TransactionClient, entry: AuditRecord): Promise<void> {
    const { fields, values } = auditedChanges(entry.subjectType, entry.changes ?? {});
    const detail: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(entry.detail ?? {})) {
      if (value !== undefined) {
        detail[name] = value as string | number | boolean;
      }
    }
    await tx.auditEntry.create({
      data: {
        organisationId: entry.organisationId,
        actorUserId: entry.actorUserId,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId ?? null,
        fields,
        changes: values as unknown as Prisma.InputJsonValue,
        detail,
        traceId: currentTraceId(),
      },
    });
  }
}
