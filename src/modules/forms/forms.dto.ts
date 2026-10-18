import { ApiProperty } from '@nestjs/swagger';
import {
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
import { FIELD_KINDS, FORM_LANGUAGES, FORM_TYPES } from './catalogue';

/** open: the form takes submissions; closed: it shows its closed message (FR-DL-02). */
export const PUBLIC_FORM_STATES = ['open', 'closed'] as const;
export type PublicFormState = (typeof PUBLIC_FORM_STATES)[number];

/** Why a form is closed: the conference is not open for submissions, or its deadline has passed. */
export const CLOSED_REASONS = ['conference_closed', 'deadline_passed', 'not_published'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

/**
 * A field of the catalogue as the configuration screen needs it (M3-ISS-05): what an admin
 * may change. A mandatory field cannot be switched off and its "required" cannot change.
 */
export class CatalogueFieldDto {
  /** The field's key, as in the configuration's `fields`. */
  field!: string;
  section!: string;
  @ApiProperty({ enum: FIELD_KINDS })
  kind!: (typeof FIELD_KINDS)[number];
  mandatory!: boolean;
  /** Required unless the admin says otherwise (a mandatory field: always as here). */
  requiredByDefault!: boolean;
  enabledByDefault!: boolean;
  /** The values of its options, whose labels an admin may change; null without options. */
  options!: string[] | null;
  /** The most characters an admin may allow; null when the field has no such limit. */
  maxLengthCap!: number | null;
  /** The most words an admin may allow; null when the field counts no words. */
  maxWordsCap!: number | null;
  /** The file types an admin may let a file field take; null for another field. */
  fileTypes!: string[] | null;
}

export class FormVersionSummaryDto {
  number!: number;
  publishedAt!: string;
  publishedBy!: { id: string; displayName: string };
}

/** A form of a conference, as the admin sees it (FR-FORM-02). */
export class FormDto {
  id!: string;
  conferenceId!: string;
  // The order of the values is fixed here, not left to the compiler (a stable contract).
  @ApiProperty({ enum: FORM_TYPES })
  type!: (typeof FORM_TYPES)[number];
  /** The form's address: /f/<slug> (hosted) and /embed/<slug> (frame). */
  slug!: string;
  /** The draft: what the admin set over the catalogue (contracts/form-configuration.schema.json). */
  configuration!: Record<string, unknown>;
  /** The definition the draft makes, for the preview (contracts/form-definition.schema.json). */
  draftDefinition!: Record<string, unknown>;
  /** The published version the public form shows; null before the first publish. */
  currentVersion!: FormVersionSummaryDto | null;
  versions!: FormVersionSummaryDto[];
  /** What the public form shows now. */
  @ApiProperty({ enum: PUBLIC_FORM_STATES })
  state!: PublicFormState;
  @ApiProperty({ enum: CLOSED_REASONS, nullable: true })
  closedReason!: ClosedReason | null;
  /** The send breaker of this form (ADR-08): confirmations above these are held. */
  breakerPerHour!: number;
  breakerPerDay!: number;
  /** The catalogue of its type: what the configuration may change (M3-ISS-05). */
  catalogue!: CatalogueFieldDto[];
  updatedAt!: string;
  version!: number;
}

export class FormSummaryDto {
  id!: string;
  conferenceId!: string;
  @ApiProperty({ enum: FORM_TYPES })
  type!: (typeof FORM_TYPES)[number];
  slug!: string;
  /** The number of the published version, null before the first publish. */
  currentVersionNumber!: number | null;
  @ApiProperty({ enum: PUBLIC_FORM_STATES })
  state!: PublicFormState;
  @ApiProperty({ enum: CLOSED_REASONS, nullable: true })
  closedReason!: ClosedReason | null;
  version!: number;
}

export class FormListDto {
  items!: FormSummaryDto[];
}

export class FormQueryDto {
  @IsOptional()
  @IsUUID('4')
  conferenceId?: string;
}

/** A form of a type for a conference; it starts with the catalogue's defaults, unpublished. */
export class CreateFormDto {
  @IsIn(FORM_TYPES)
  @ApiProperty({ enum: FORM_TYPES })
  type!: (typeof FORM_TYPES)[number];
}

/** A new draft (FR-FORM-02). Refused field by field: `configuration.<path>` and a code. */
export class FormDraftDto {
  /** contracts/form-configuration.schema.json. */
  @IsObject()
  configuration!: Record<string, unknown>;

  @IsInt()
  @Min(1)
  version!: number;
}

export class FormVersionRefDto {
  @IsInt()
  @Min(1)
  version!: number;
}

/** The send breaker of a form (ADR-08; P: 30 an hour, 200 a day). */
export class FormBreakerDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  breakerPerHour!: number;

  @IsInt()
  @Min(1)
  @Max(100_000)
  breakerPerDay!: number;

  @IsInt()
  @Min(1)
  version!: number;
}

export class FormVersionDto {
  number!: number;
  publishedAt!: string;
  publishedBy!: { id: string; displayName: string };
  definition!: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** A published form as the public page renders it (ADR-08, ADR-FE-04). */
export class PublicFormDto {
  slug!: string;
  @ApiProperty({ enum: PUBLIC_FORM_STATES })
  state!: PublicFormState;
  @ApiProperty({
    enum: CLOSED_REASONS,
    nullable: true,
    description:
      'Why a closed form is closed (UX3-03): `deadline_passed`, its last day is over (the page may name `deadline`); `conference_closed`, the office closed submissions before or without the deadline (the page names no date); `not_published`. Null while open.',
  })
  closedReason!: ClosedReason | null;
  /** The last day of submissions (inclusive), YYYY-MM-DD, in the conference's time zone; null without a deadline. */
  deadline!: string | null;
  /** The instant the form closes (the start of the day after the deadline there); null without one. */
  closesAt!: string | null;
  conference!: { code: string; name: string; timeZone: string; languages: string[] };
  /** The links a consent text may name (D6): `terms` and `privacy`, https or null. */
  consentLinks!: { terms: string | null; privacy: string | null };
  /** Whom an author writes to (D8): the contact email of the organisation profile, or null. */
  contactEmail!: string | null;
  /** The number of the version: a submission keeps it. */
  versionNumber!: number;
  /** contracts/form-definition.schema.json. */
  definition!: Record<string, unknown>;
}

/** The sites that may frame the form (ADR-07): what `frame-ancestors` of /embed/<key> names. */
export class FrameSitesDto {
  sites!: string[];
}

/**
 * The request of a form token: `{}` for a first one. When the API refused a token (expired
 * 403 `form_token_invalid`, used 409 `form_token_used`, or 403 `proof_of_work_failed` for a
 * token without a challenge), the page asks for a new one with the refused token in
 * `previousFormToken` (Q3-01): the renewal keeps the files uploaded with it and the moment
 * the author began, so the submit that follows at once is not taken for a script.
 */
export class FormTokenRequestDto {
  /** The refused token of this form, issued within the last 24 hours. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  previousFormToken?: string;
}

/** The proof-of-work a token asks for under load (ADR-08), or none. */
export class ProofOfWorkDto {
  challenge!: string;
  /** Leading zero bits of SHA-256(challenge + ":" + counter). */
  difficulty!: number;
}

/**
 * A single-use form token (ADR-08): sent in the header `X-Form-Token` with every upload and
 * the submit. Fetched by the page, never rendered into it.
 */
export class FormTokenDto {
  // A credential the page needs once: its only appearance, never logged, never stored.
  formToken!: string;
  expiresAt!: string;
  proofOfWork!: ProofOfWorkDto | null;
}

/** An uploaded file, bound to the token and the file field until the submit attaches it. */
export class UploadedFileDto {
  fileId!: string;
  /** The name as it will be shown and downloaded: cleaned, with the extension of its content. */
  name!: string;
  sizeBytes!: number;
  @ApiProperty({ enum: ['pdf', 'docx', 'doc', 'jpeg', 'png'] })
  type!: 'pdf' | 'docx' | 'doc' | 'jpeg' | 'png';
}

/**
 * A submit (ADR-08): the answers by field key (contracts/form-rule-vectors.json), the
 * language, the trap field, and the proof-of-work when the token asks for one. Headers:
 * `X-Form-Token` and `Idempotency-Key` (a UUID made once per form and kept with the draft).
 */
export class SubmitDto {
  @IsIn(FORM_LANGUAGES)
  @ApiProperty({ enum: FORM_LANGUAGES })
  language!: (typeof FORM_LANGUAGES)[number];

  @IsObject()
  answers!: Record<string, unknown>;

  /**
   * The trap: a field no person sees, with a name no autofill fills (SEC-M3-07; the page
   * renders it `autocomplete="off"` in an inert container). It must be empty.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  confera_hp?: string;

  /** The counter that answers the token's challenge (a decimal number as text). */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{1,12}$/)
  proofOfWork?: string;
}

export class SubmittedDto {
  /** Shown to the author: IT27-0001. */
  reference!: string;
  receivedAt!: string;
  @ApiProperty({ enum: FORM_LANGUAGES })
  language!: (typeof FORM_LANGUAGES)[number];
}
