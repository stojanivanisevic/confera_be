import { Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { Permission } from '../access/access.decorators';
import {
  MailLogEntryDto,
  MailLogPageDto,
  MailLogQueryDto,
  MailLogSummaryDto,
} from './mail-log.dto';

type Row = Prisma.MailLogEntryGetPayload<object>;

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
    sentAt: row.sentAt.toISOString(),
  };
}

/** The mail log (FR-SMTP-04, ADR-13), newest first. */
@AdminController('mail-log')
export class MailLogController {
  constructor(private readonly database: TenantDatabase) {}

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
          orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]),
    );
    return { items: rows.map(summaryOf), total, page, pageSize };
  }

  @Get(':id')
  @Permission('mail_log.read')
  async getMailLogEntry(
    @Param('id', new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND }))
    id: string,
  ): Promise<MailLogEntryDto> {
    const row = await this.database.db.mailLogEntry.findUnique({ where: { id } });
    if (row === null) {
      throw new ProblemException(404, 'not_found');
    }
    return Object.assign(summaryOf(row), {
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      bodyText: row.bodyText,
    });
  }
}
