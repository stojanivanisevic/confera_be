import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MAIL_KINDS } from '../mail/mail-queue';

/** One attempt of one message (FR-SMTP-04). Without its content; see MailLogEntryDto. */
export class MailLogSummaryDto {
  id!: string;
  messageId!: string;
  recipient!: string;
  /** The template type. */
  kind!: string;
  language!: string;
  conferenceId!: string | null;
  mailServerId!: string | null;
  /** The name of the server when it was used. */
  serverName!: string | null;
  attempt!: number;
  // The order of the values is fixed here, not left to the compiler (a stable contract).
  @ApiProperty({ enum: ['sent', 'failed'] })
  result!: 'sent' | 'failed';
  /** A code, never the server's words. */
  errorCode!: string | null;
  /**
   * True when the attempt went to the mail catcher of the staging server and not to the
   * configured server (ADR-27, ST-50); `recipient` is still the original recipient.
   */
  diverted!: boolean;
  sentAt!: string;
}

/**
 * An entry with what was sent, every secure link as `[link]` (ADR-13). Null content when
 * the organisation keeps none. The web application shows the HTML only in a sandboxed
 * frame without scripts or same-origin (ST-28).
 */
export class MailLogEntryDto extends MailLogSummaryDto {
  subject!: string | null;
  bodyHtml!: string | null;
  bodyText!: string | null;
}

export class MailLogPageDto {
  items!: MailLogSummaryDto[];
  total!: number;
  page!: number;
  pageSize!: number;
}

export class MailLogQueryDto {
  @IsOptional()
  @IsIn(MAIL_KINDS)
  kind?: string;

  @IsOptional()
  @IsIn(['sent', 'failed'])
  result?: string;

  @IsOptional()
  @IsUUID('4')
  conferenceId?: string;

  @IsOptional()
  @IsUUID('4')
  messageId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
