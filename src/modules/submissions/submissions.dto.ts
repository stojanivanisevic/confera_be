import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { isMultilineText, Satisfies } from '../../common/validation/satisfies';
import { HeldNumbersDto } from '../held-mail/held-mail.dto';
import { MAX_QUERY_LENGTH } from './search';
import { STATUS_ACTIONS, SUBMISSION_STATUSES } from './status-machine';

/** The largest page of a list (ST-41: a page size above it is refused). */
export const MAX_PAGE_SIZE = 100;

export const SCAN_STATES = ['pending', 'clean', 'infected', 'not_clean'] as const;
export const SCAN_FLAGS = ['macros', 'external_links'] as const;
/**
 * Why a file cannot be downloaded (UX3-07): `scan_pending`, it waits for its first scan;
 * `scan_retrying`, the scanner did not answer and the scan is tried again at `nextScanAt`;
 * `file_not_clean`, infected or beyond the scanner's limits, never.
 */
export const DOWNLOAD_BLOCKS = ['scan_pending', 'scan_retrying', 'file_not_clean'] as const;

/**
 * The orders of the table (M4-BE-04): a fixed map from these names to columns, never a
 * column named by the client. Ties are broken by the id, so that pages never overlap.
 */
export const SUBMISSION_SORTS = [
  'receivedAt',
  'reference',
  'title',
  'firstAuthor',
  'institution',
  'participationType',
  'status',
  'conference',
] as const;
export type SubmissionSort = (typeof SUBMISSION_SORTS)[number];

/** A list in a query: `status=new,open` or the parameter repeated. */
function listOf({ value }: { value: unknown }): unknown {
  const values: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  return values
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : [item]))
    .filter((item) => item !== '');
}

/** What the table shows of the files of a submission (UX3-07), without opening it. */
export class SubmissionFileSignsDto {
  /** The flags its files carry, each once, in this order: macros, external_links. */
  @ApiProperty({ enum: SCAN_FLAGS, isArray: true })
  flags!: (typeof SCAN_FLAGS)[number][];
  /** Whether a file still waits for its virus scan. */
  scanPending!: boolean;
}

/** One row of the submissions table (FR-SUB-02). Member match and billing arrive with 0.8.0 and 0.6.0. */
export class SubmissionSummaryDto {
  id!: string;
  reference!: string;
  conference!: { id: string; code: string; name: string; editionYear: number | null };
  title!: string | null;
  firstAuthor!: string;
  institution!: string | null;
  participationType!: string | null;
  /** The status of Spec section 5. */
  @ApiProperty({ enum: SUBMISSION_STATUSES })
  status!: (typeof SUBMISSION_STATUSES)[number];
  /** Not matched yet (0.8.0). */
  memberMatch!: string | null;
  /** No proforma yet (0.6.0). */
  billingStatus!: string | null;
  language!: string;
  authorCount!: number;
  receivedAt!: string;
  fileSigns!: SubmissionFileSignsDto;
  /** Raised by every change of status or data: send it with the next change (409 otherwise). */
  version!: number;
}

export class SubmissionPageDto {
  items!: SubmissionSummaryDto[];
  /** All rows that match the search and the filters, on every page. */
  total!: number;
  page!: number;
  pageSize!: number;
}

/**
 * The table's search, filters, order and page (FR-SUB-03, M4-BE-04). Without a `status`
 * filter a withdrawn submission is left out (FR-SUB-08); it is found with `status=withdrawn`.
 */
export class SubmissionQueryDto {
  /**
   * Searched in reference, title, the authors' names, emails and institutions, without
   * diacritics both ways ("Zivkovic" finds "Živković", "Djordje" finds "Đorđe", Serbian
   * Cyrillic finds the Latin spelling). Every word must occur.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUERY_LENGTH)
  q?: string;

  @IsOptional()
  @IsUUID('4')
  conferenceId?: string;

  /** One status or several, comma-separated: `status=new,open`. */
  @IsOptional()
  @Transform(listOf)
  @IsArray()
  @ArrayMaxSize(SUBMISSION_STATUSES.length)
  @IsIn(SUBMISSION_STATUSES, { each: true })
  @ApiProperty({ required: false, enum: SUBMISSION_STATUSES, isArray: true })
  status?: (typeof SUBMISSION_STATUSES)[number][];

  /** One participation type or several, comma-separated (the options of the form's field). */
  @IsOptional()
  @Transform(listOf)
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(/^[a-z][a-z0-9_]{0,40}$/, { each: true })
  @ApiProperty({ required: false, type: [String] })
  participationType?: string[];

  @IsOptional()
  @IsIn(SUBMISSION_SORTS)
  @ApiProperty({ required: false, enum: SUBMISSION_SORTS, default: 'receivedAt' })
  sort?: SubmissionSort;

  /** Default: newest first for `receivedAt`, A to Z for the rest. */
  @IsOptional()
  @IsIn(['asc', 'desc'])
  @ApiProperty({ required: false, enum: ['asc', 'desc'] })
  order?: 'asc' | 'desc';

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
  @ApiProperty({ enum: SCAN_FLAGS, nullable: true })
  scanFlag!: (typeof SCAN_FLAGS)[number] | null;
  /** When the scan ended, or since when it waits. */
  scannedAt!: string | null;
  pendingSince!: string | null;
  /** Pending: when the next scan is due. */
  nextScanAt!: string | null;
  /** Null: it may be downloaded. Otherwise why not, yet or ever (UX3-07). */
  @ApiProperty({ enum: DOWNLOAD_BLOCKS, nullable: true })
  downloadBlocked!: (typeof DOWNLOAD_BLOCKS)[number] | null;
  sha256!: string;
}

export class PersonDto {
  id!: string;
  displayName!: string;
}

/** A change of the status (Spec section 5), with what became of its email. */
export class SubmissionStatusDto {
  @ApiProperty({ enum: SUBMISSION_STATUSES })
  status!: (typeof SUBMISSION_STATUSES)[number];
  @ApiProperty({ enum: SUBMISSION_STATUSES, nullable: true })
  fromStatus!: (typeof SUBMISSION_STATUSES)[number] | null;
  /** The row of the state table: 1 (the form), 2, 4 to 9. */
  transition!: number;
  changedAt!: string;
  /** Null for the author's own submit (transition 1). */
  actor!: PersonDto | null;
  /** The internal reason of a withdrawal or a reopening: for the admins only, never sent. */
  reason!: string | null;
  /** The text for the author that the email carried (FR-MAIL-08). */
  message!: string | null;
  /** `queued`: the email is `emailId`; `template_off`: no email, switched off (FR-MAIL-07); `none`. */
  @ApiProperty({ enum: ['queued', 'template_off', 'none'] })
  email!: 'queued' | 'template_off' | 'none';
  emailId!: string | null;
}

/** An email about the submission (its confirmation, its status emails), with what became of it. */
export class SubmissionEmailDto {
  id!: string;
  kind!: string;
  recipient!: string;
  /** queued, sending, sent, failed, held, stuck, waiting_for_server or discarded. */
  status!: string;
  heldReason!: string | null;
  /** The numbers of the hold, as in the held emails (UX3-06); null when not held or unknown. */
  heldBy!: HeldNumbersDto | null;
  lastErrorCode!: string | null;
  createdAt!: string;
  sentAt!: string | null;
}

/** A note of an admin (FR-SUB-07): admins only, never shown to authors or reviewers. */
export class SubmissionNoteDto {
  id!: string;
  body!: string;
  author!: PersonDto;
  createdAt!: string;
}

/** A kept revision (FR-SUB-06): what an admin corrected, old and new answers of each field. */
export class SubmissionRevisionDto {
  number!: number;
  changedAt!: string;
  changedBy!: PersonDto;
  /** The answer keys that changed. */
  fields!: string[];
  /** The values of those keys before and after; the first revision's `before` is the original. */
  before!: Record<string, unknown>;
  after!: Record<string, unknown>;
}

/** Everything about one submission (FR-SUB-04, FR-SUB-01). */
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
  /** The changes of status an admin may make now, in the order of the state table. */
  @ApiProperty({ enum: STATUS_ACTIONS, isArray: true })
  actions!: (typeof STATUS_ACTIONS)[number][];
  emails!: SubmissionEmailDto[];
  notes!: SubmissionNoteDto[];
  revisions!: SubmissionRevisionDto[];
}

/** The texts a change of status may carry (Spec section 5, FR-MAIL-08). */
export class StatusTextsDto {
  @IsIn(STATUS_ACTIONS)
  @ApiProperty({ enum: STATUS_ACTIONS })
  action!: (typeof STATUS_ACTIONS)[number];

  /** The internal reason: required to withdraw and to reopen, refused otherwise; never sent. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Satisfies('isMultilineText', isMultilineText)
  reason?: string;

  /**
   * The text for the author, carried by the email word for word: required to return for
   * revision, allowed to reject, withdraw and reopen, refused otherwise.
   */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @Satisfies('isMultilineText', isMultilineText)
  message?: string;
}

/**
 * A change of status (POST, with the CSRF header: never a GET, ST-43). `version` is the
 * submission's; a repeat of the same request is refused (409 `version_conflict`) and sends
 * no second email. `previewDigest` is the one of the preview the admin saw (FR-MAIL-08),
 * required for every change whose email is on, with or without a `message`, except `open`
 * (SEC-M4-05; 400 `validation_failed` at `previewDigest` without it): the email sent is
 * exactly that one, or the change is refused (409 `preview_outdated`, when the template
 * changed in the meantime).
 */
export class StatusChangeDto extends StatusTextsDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  previewDigest?: string;
}

/** The email a change of status would send (FR-MAIL-08), before anything changes. */
export class StatusEmailPreviewDto {
  /** False when the conference switched this email off (FR-MAIL-07): nothing will be sent. */
  sends!: boolean;
  to!: string | null;
  language!: string | null;
  subject!: string | null;
  /** The HTML with its images embedded: show it in a sandboxed frame only (ST-28). */
  html!: string | null;
  text!: string | null;
  /** Send it back with the change (every action but `open`, SEC-M4-05). */
  previewDigest!: string | null;
}

export class NoteDto {
  @IsString()
  @MaxLength(5000)
  @Satisfies('isMultilineText', isMultilineText)
  body!: string;
}

/**
 * A correction on the author's behalf (FR-SUB-06): the answers that change, by field key
 * (a section such as `authors` as a whole), checked by the rules of the form's version like
 * a submit. A file field cannot be changed here. The old values stay in the revisions.
 */
export class SubmissionEditDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsObject()
  answers!: Record<string, unknown>;
}
