import { Module } from '@nestjs/common';
import { MailServersController } from './mail-servers.controller';
import { MailServersService } from './mail-servers.service';

/** Mail servers (FR-SMTP-01 to 03, ADR-11). */
@Module({ controllers: [MailServersController], providers: [MailServersService] })
export class MailServersModule {}
