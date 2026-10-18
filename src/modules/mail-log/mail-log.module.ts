import { Module } from '@nestjs/common';
import { MailLogController, MailLogService } from './mail-log.controller';

/** The mail log (FR-SMTP-04 to 06): the entries, resending, and how long they are kept. */
@Module({ controllers: [MailLogController], providers: [MailLogService] })
export class MailLogModule {}
