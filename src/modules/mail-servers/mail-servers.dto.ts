import { ApiProperty } from '@nestjs/swagger';
import { IsOptionalNotNull } from '../../common/validation/presence';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsMailAddress } from '../../common/validation/mail-address';
import { IsPlainText } from '../../common/validation/plain-text';
import { Satisfies } from '../../common/validation/satisfies';
import { isHostName, TLS_MODES, type TlsMode } from './mail-server-policy';

/**
 * A mail server as the API shows it (FR-SMTP-01, ADR-11). The password is write-only:
 * a request may set it, no response ever carries it; `credentialSet` says whether one is
 * stored. It is cleared when host, port, user or TLS mode change without a new one.
 */
export class MailServerDto {
  id!: string;
  name!: string;
  host!: string;
  port!: number;
  /** implicit (TLS from the first byte), starttls (required), none (developer machines only). */
  // The order of the values is fixed here, not left to the compiler (a stable contract).
  @ApiProperty({ enum: TLS_MODES })
  tlsMode!: TlsMode;
  username!: string | null;
  /** Whether a password is stored. The password itself is never returned. */
  credentialSet!: boolean;
  /** When the stored password was set. */
  credentialSetAt!: string | null;
  fromAddress!: string;
  fromName!: string;
  /** The organisation's default server, last in the order of FR-SMTP-02. */
  isDefault!: boolean;
  /** Tried when sending through the chosen server fails. */
  isFallback!: boolean;
  enabled!: boolean;
  /** Messages a minute the worker sends through this server at most. */
  sendRatePerMinute!: number;
  version!: number;
}

export class MailServerListDto {
  items!: MailServerDto[];
}

/** A new mail server. Asks for the password again and tells every active admin. */
export class CreateMailServerDto {
  @IsPlainText()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @Satisfies('isHostName', isHostName)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65_535)
  port!: number;

  @IsIn(TLS_MODES)
  // The order of the values is fixed here, not left to the compiler (a stable contract).
  @ApiProperty({ enum: TLS_MODES })
  tlsMode!: TlsMode;

  @IsOptional()
  @IsPlainText()
  @MaxLength(254)
  username?: string | null;

  /** Write-only. Stored sealed (AES-256-GCM), never returned. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  password?: string;

  @IsMailAddress()
  fromAddress!: string;

  @IsPlainText()
  @MinLength(1)
  @MaxLength(100)
  fromName!: string;

  @IsOptionalNotNull()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptionalNotNull()
  @IsBoolean()
  isFallback?: boolean;

  @IsOptionalNotNull()
  @IsBoolean()
  enabled?: boolean;

  @IsOptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(600)
  sendRatePerMinute?: number;
}

/**
 * A change of a mail server. A field left out stays as it is. A change of host, port,
 * user or TLS mode without `password` clears the stored password (ADR-11, ST-20); `password`
 * null clears it too.
 */
export class UpdateMailServerDto {
  @IsOptionalNotNull()
  @IsPlainText()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptionalNotNull()
  @IsString()
  @Satisfies('isHostName', isHostName)
  host?: string;

  @IsOptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(65_535)
  port?: number;

  @IsOptionalNotNull()
  @IsIn(TLS_MODES)
  tlsMode?: TlsMode;

  @IsOptional()
  @IsPlainText()
  @MaxLength(254)
  username?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  password?: string | null;

  @IsOptionalNotNull()
  @IsMailAddress()
  fromAddress?: string;

  @IsOptionalNotNull()
  @IsPlainText()
  @MinLength(1)
  @MaxLength(100)
  fromName?: string;

  @IsOptionalNotNull()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptionalNotNull()
  @IsBoolean()
  isFallback?: boolean;

  @IsOptionalNotNull()
  @IsBoolean()
  enabled?: boolean;

  @IsOptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(600)
  sendRatePerMinute?: number;

  @IsInt()
  @Min(1)
  version!: number;
}

export class MailServerVersionQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

/** Where the test message goes: one address. */
export class TestMessageDto {
  @IsMailAddress()
  to!: string;

  @IsOptional()
  @IsIn(['en', 'sr'])
  language?: 'en' | 'sr';
}

/** The causes a failed test message names (M2-ISS-14). A timeout counts as no connection. */
export const TEST_FAILURE_CAUSES = [
  'connection_failed',
  'certificate_refused',
  'authentication_failed',
  'recipient_refused',
  'send_failed',
] as const;

/**
 * The result of a test message (ADR-11): generic. `refused` names a rule of Confera that
 * stopped it before any connection; a failure of the server is only `failed`, with no
 * word of the server's answer, so that the test is no scanner of the network.
 */
export class TestMessageResultDto {
  // The order of the values is fixed here, not left to the compiler (a stable contract).
  @ApiProperty({ enum: ['sent', 'failed', 'refused'] })
  result!: 'sent' | 'failed' | 'refused';
  /** With `refused`: tls_required, port_not_allowed or address_not_allowed. */
  reason!: string | null;
  /**
   * With `failed`, what kind of failure it was (M2-ISS-14, UXUI-M2-11), as a code and never
   * the server's words: `connection_failed` (no connection, or none in time),
   * `certificate_refused`, `authentication_failed`, `recipient_refused` or `send_failed`.
   */
  @ApiProperty({ enum: TEST_FAILURE_CAUSES, nullable: true })
  cause!: (typeof TEST_FAILURE_CAUSES)[number] | null;
}
