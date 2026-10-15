import { Module } from '@nestjs/common';
import { MailLogController } from './mail-log.controller';

/** The mail log, read only (FR-SMTP-04). */
@Module({ controllers: [MailLogController] })
export class MailLogModule {}
