import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** The largest page of a list (ST-41: a page size above it is refused). */
export const MAX_PAGE_SIZE = 100;

export const SCAN_STATES = ['pending', 'clean', 'infected', 'not_clean'] as const;

/** One row of the submissions table (FR-SUB-02). Member match and billing arrive with 0.8.0 and 0.6.0. */
export class SubmissionSummaryDto {
  id!: string;
  reference!: string;
  conference!: { id: string; code: string; name: string; editionYear: number | null };
  title!: string | null;
  firstAuthor!: string;
  institution!: string | null;
  participationType!: string | null;
  status!: string;
  /** Not matched yet (0.8.0). */
  memberMatch!: string | null;
  /** No proforma yet (0.6.0). */
  billingStatus!: string | null;
  language!: string;
  authorCount!: number;
  receivedAt!: string;
}

export class SubmissionPageDto {
  items!: SubmissionSummaryDto[];
  total!: number;
  page!: number;
  pageSize!: number;
}

export class SubmissionQueryDto {
  @IsOptional()
  @IsUUID('4')
  conferenceId?: string;

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
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}

export class SubmissionAuthorDto {
  position!: number;
  firstName!: string;
  lastName!: string;
  institution!: string | null;
  institutionAddress!: string | null;
  orcid!: string | null;
  email!: string;
  phone!: string | null;
  isCorresponding!: boolean;
}

/** A file of a submission (FR-FILE-02): downloadable only once its scan is clean. */
export class SubmissionFileDto {
  id!: string;
  /** The file field of the form it was uploaded for. */
  field!: string | null;
  name!: string;
  @ApiProperty({ enum: ['pdf', 'docx', 'doc', 'jpeg', 'png'] })
  type!: string;
  sizeBytes!: number;
  @ApiProperty({ enum: SCAN_STATES })
  scanState!: (typeof SCAN_STATES)[number];
  /**
   * `macros`: an old .doc with macros, accepted and flagged for the office (G2-22);
   * `external_links`: a .docx with a remote template, frame or object, or a UNC path (SEC-M3-06).
   */
  scanFlag!: string | null;
  /** When the scan ended, or since when it waits. */
  scannedAt!: string | null;
  pendingSince!: string | null;
  sha256!: string;
}

export class SubmissionStatusDto {
  status!: string;
  changedAt!: string;
  actor!: { id: string; displayName: string } | null;
}

/** An email about the submission (its confirmation), with what became of it. */
export class SubmissionEmailDto {
  id!: string;
  kind!: string;
  recipient!: string;
  /** queued, sending, sent, failed, held, stuck or waiting_for_server. */
  status!: string;
  heldReason!: string | null;
  lastErrorCode!: string | null;
  createdAt!: string;
  sentAt!: string | null;
}

/** Everything about one submission that exists in 0.3.0 (FR-SUB-04, FR-SUB-01). */
export class SubmissionDetailDto extends SubmissionSummaryDto {
  form!: { id: string; slug: string; versionNumber: number };
  /** The answers by field key, as checked (contracts/form-rule-vectors.json). */
  answers!: Record<string, unknown>;
  authors!: SubmissionAuthorDto[];
  files!: SubmissionFileDto[];
  consent!: {
    text: string;
    links: Record<string, string | null>;
    version: string;
    consentedAt: string;
  };
  statusHistory!: SubmissionStatusDto[];
  emails!: SubmissionEmailDto[];
}
