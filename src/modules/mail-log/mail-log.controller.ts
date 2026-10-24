import { randomUUID } from 'node:crypto';
import {
  Body,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import { AuditRecorder } from '../audit/audit-recorder';
import { changedSince, linkRequestedAt, STALE_REASONS } from '../mail/link-staleness';
import { type MailKind, MailQueue } from '../mail/mail-queue';
import {
  MailLogEntryDto,
  MailLogPageDto,
  MailLogQueryDto,
  MailLogRetentionDto,
  MailLogRetentionUpdateDto,
  MailLogSummaryDto,
  ResentDto,
} from './mail-log.dto';

type Row = Prisma.MailLogEntryGetPayload<{
  include: { message: { select: { resendOf: true; resendMode: true } } };
}>;

function summaryOf(row: Row): MailLogSummaryDto {
  return {
    id: row.id,
    messageId: row.messageId,
    recipient: row.recipient,
    kind: row.kind,
    language: row.language,
    conferenceId: row.conferenceId,
    mailServerId: row.mailServerId,
    serverName: row.serverName,
    attempt: row.attempt,
    result: row.result as 'sent' | 'failed',
    errorCode: row.errorCode,
    diverted: row.diverted,
    subject: row.subject,
    resendOf: row.message.resendOf,
    resendMode: row.message.resendMode as 'copy' | 'rendered_again' | null,
    sentAt: row.sentAt.toISOString(),
  };
}

const INCLUDE = { message: { select: { resendOf: true, resendMode: true } } } as const;

/**
 * The kinds that are never resent: a test message is sent anew from its server; an email
 * change is confirmed by a link to an address the account does not have yet, so a resend
 * would make a live link that moves the account to an address someone once typed
 * (SEC-M4-02): the person asks for the change again.
 */
const NOT_RESENT: readonly string[] = ['test_message', 'email_change_confirmation'];

/**
 * Resending and the retention of the mail log (M4-BE-05; FR-SMTP-05, FR-SMTP-06).
 *
 * A resend is a new message that names the one it repeats. When the content of the first
 * was kept (the organisation's setting `mailLogContent`), it is sent as it was, with a
 * fresh secure link that ends the earlier one (`copy`); otherwise the template is rendered
 * again now (`rendered_again`). The log entry of each attempt says which.
 */
@Injectable()
export class MailLogService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly mail: MailQueue,
    private readonly audit: AuditRecorder,
  ) {}

  async resend(actor: Access, entryId: string): Promise<ResentDto> {
    return this.database.transaction(async (tx) => {
      const entry = await tx.mailLogEntry.findUnique({
        where: { id: entryId },
        include: { message: true },
      });
      if (entry === null) {
        throw new ProblemException(404, 'not_found');
      }
      const original = entry.message;
      if (
        NOT_RESENT.includes(original.kind) ||
        original.linkPurpose === 'email_change' ||
        !['sent', 'failed', 'stuck'].includes(original.status)
      ) {
        throw new ProblemException(409, 'resend_refused');
      }
      if (original.linkPurpose !== null && (await this.isStale(tx, original))) {
        throw new ProblemException(409, 'resend_refused');
      }
      const id = randomUUID();
      const uniqueKey = `resend:${original.id}:${id}`;
      const copy =
        original.renderedSubject !== null &&
        original.renderedHtml !== null &&
        original.renderedText !== null;
      await tx.mailMessage.create({
        data: {
          id,
          organisationId: actor.organisationId,
          uniqueKey,
          kind: original.kind,
          recipientUserId: original.recipientUserId,
          recipientAddress: original.recipientAddress,
          linkPurpose: original.linkPurpose,
          linkUserId: original.linkUserId,
          parameters: original.parameters as Prisma.InputJsonValue,
          language: original.language,
          conferenceId: original.conferenceId,
          formId: original.formId,
          submissionId: original.submissionId,
          resendOf: original.id,
          resendMode: copy ? 'copy' : 'rendered_again',
          ...(copy
            ? {
                renderedSubject: original.renderedSubject,
                renderedHtml: original.renderedHtml,
                renderedText: original.renderedText,
                templateServerId: original.templateServerId,
                imageIds: original.imageIds,
              }
            : {}),
        },
      });
      if (!copy) {
        // The row exists under its key: the queue renders it now, from the template as it is.
        await this.mail.enqueue(tx, {
          id,
          organisationId: actor.organisationId,
          kind: original.kind as MailKind,
          recipientAddress: original.recipientAddress,
          uniqueKey,
        });
      }
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'mail.resent',
        subjectType: 'mail_message',
        subjectId: original.id,
      });
      return {
        messageId: id,
        resendOf: original.id,
        resendMode: copy ? ('copy' as const) : ('rendered_again' as const),
      };
    });
  }

  /**
   * A message with a link that is no longer true is not resent (SEC-M4-02): it failed as
   * stale, or the password or the address changed after its link was first asked for. The
   * sender judges the resend by that time again when it sends.
   */
  private async isStale(
    tx: Prisma.TransactionClient,
    original: {
      createdAt: Date;
      resendOf: string | null;
      status: string;
      lastErrorCode: string | null;
      linkUserId: string | null;
    },
  ): Promise<boolean> {
    if (original.status === 'failed' && STALE_REASONS.includes(original.lastErrorCode ?? '')) {
      return true;
    }
    if (original.linkUserId === null) {
      return true;
    }
    const user = await tx.user.findUnique({
      where: { id: original.linkUserId },
      select: { passwordChangedAt: true, emailChangedAt: true },
    });
    return (
      user === null ||
      changedSince(
        user,
        await linkRequestedAt(
          (id) =>
            tx.mailMessage.findUnique({
              where: { id },
              select: { createdAt: true, resendOf: true },
            }),
          original,
        ),
      )
    );
  }

  async retention(): Promise<MailLogRetentionDto> {
    const organisation = await this.database.db.organisation.findFirstOrThrow({
      select: { mailLogRetentionDays: true, version: true },
    });
    return { days: organisation.mailLogRetentionDays, version: organisation.version };
  }

  async setRetention(
    actor: Access,
    input: MailLogRetentionUpdateDto,
  ): Promise<MailLogRetentionDto> {
    await this.database.transaction(async (tx) => {
      const before = await tx.organisation.findFirstOrThrow({
        select: { id: true, mailLogRetentionDays: true },
      });
      const changed = await tx.organisation.updateMany({
        where: { id: before.id, version: input.version },
        data: {
          mailLogRetentionDays: input.days,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'mail_log.retention_changed',
        subjectType: 'mail_log_retention',
        subjectId: before.id,
        changes: {
          days: { old: String(before.mailLogRetentionDays), new: String(input.days) },
        },
      });
    });
    return this.retention();
  }
}

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

/** The mail log (FR-SMTP-04 to 06, ADR-13), newest first. */
@AdminController('mail-log')
export class MailLogController {
  constructor(
    private readonly database: TenantDatabase,
    private readonly log: MailLogService,
  ) {}

  @Get()
  @Permission('mail_log.read')
  async listMailLog(@Query() query: MailLogQueryDto): Promise<MailLogPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where: Prisma.MailLogEntryWhereInput = {
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.result === undefined ? {} : { result: query.result }),
      ...(query.conferenceId === undefined ? {} : { conferenceId: query.conferenceId }),
      ...(query.messageId === undefined ? {} : { messageId: query.messageId }),
    };
    const [total, rows] = await this.database.transaction((tx) =>
      Promise.all([
        tx.mailLogEntry.count({ where }),
        tx.mailLogEntry.findMany({
          where,
          include: INCLUDE,
          orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]),
    );
    return { items: rows.map(summaryOf), total, page, pageSize };
  }

  /** How long the log keeps an entry (FR-SMTP-06): 24 months unless an admin set another period. */
  @Get('retention')
  @Permission('mail_log.read')
  getMailLogRetention(): Promise<MailLogRetentionDto> {
    return this.log.retention();
  }

  /** Sets the retention: entries older than it are removed by the next run of the job. */
  @Put('retention')
  @Permission('mail_log.manage')
  setMailLogRetention(
    @CurrentAccess() access: Access,
    @Body() body: MailLogRetentionUpdateDto,
  ): Promise<MailLogRetentionDto> {
    return this.log.setRetention(access, body);
  }

  @Get(':id')
  @Permission('mail_log.read')
  async getMailLogEntry(@Param('id', ID) id: string): Promise<MailLogEntryDto> {
    const row = await this.database.db.mailLogEntry.findUnique({
      where: { id },
      include: INCLUDE,
    });
    if (row === null) {
      throw new ProblemException(404, 'not_found');
    }
    return Object.assign(summaryOf(row), {
      bodyHtml: row.bodyHtml,
      bodyText: row.bodyText,
      imageIds: row.imageIds,
    });
  }

  /**
   * Resends the message of this entry (FR-SMTP-05): as it was sent, with a fresh secure link
   * that ends the earlier one, or rendered again from the template when the content was not
   * kept. 409 `resend_refused` for a test message, an email change confirmation, a message
   * that is not done yet, and a link that is no longer true (it failed as stale, or the
   * password or the address changed after it was asked for; SEC-M4-02).
   */
  @Post(':id/resend')
  @Permission('mail_log.manage')
  @HttpCode(200)
  resendMailLogEntry(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
  ): Promise<ResentDto> {
    return this.log.resend(access, id);
  }
}
