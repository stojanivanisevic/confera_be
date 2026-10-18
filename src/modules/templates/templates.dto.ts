import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { STATUS_TEMPLATE_TYPES } from '../submissions/status-machine';
import { LANGUAGES, TEMPLATE_TYPES } from './placeholders';

/** The placeholders and conditions one template type may use (ADR-12, FR-MAIL-02). */
export class TemplateTypeDto {
  type!: string;
  /** A status email (FR-MAIL-03): one per change of status; it can be switched off per conference. */
  statusEmail!: boolean;
  placeholders!: string[];
  conditions!: string[];
  /** Whether a message of this type carries a secure link: the address of a link node. */
  carriesLink!: boolean;
}

export class TemplateCatalogueDto {
  types!: TemplateTypeDto[];
  languages!: string[];
}

/**
 * An email template (ADR-12): the subject and the body as documents of the format of
 * contracts/template-vectors.json. Of the organisation (`conferenceId` null) or overriding
 * it for one conference.
 */
export class MailTemplateDto {
  id!: string;
  conferenceId!: string | null;
  type!: string;
  language!: string;
  /** A subject document: type subject, with text and placeholder children. */
  subject!: Record<string, unknown>;
  /** A body document: type doc, with block children. */
  body!: Record<string, unknown>;
  /** The server of this template, first in the order of FR-SMTP-02. */
  mailServerId!: string | null;
  updatedAt!: string;
  version!: number;
}

export class MailTemplateListDto {
  items!: MailTemplateDto[];
}

export class MailTemplateQueryDto {
  /** Only the templates of this conference; without it, only the organisation's own. */
  @IsOptional()
  @IsUUID('4')
  conferenceId?: string;

  @IsOptional()
  @IsIn(TEMPLATE_TYPES)
  type?: string;

  @IsOptional()
  @IsIn(LANGUAGES)
  language?: string;
}

/**
 * A new template (FR-MAIL-01): a language version of the organisation's, or an override for
 * one conference. The documents are checked on save (ADR-12, ST-58): 400 with the path and
 * the code of the format (`body.children[0].href`, `link_scheme`), `image_unknown` for an
 * image that is no email image of the organisation, `too_large` for a body that would
 * render above 100 KB. 409 `template_exists` when that version exists already.
 */
export class CreateMailTemplateDto {
  @IsOptional()
  @IsUUID('4')
  conferenceId?: string | null;

  @IsIn(TEMPLATE_TYPES)
  @ApiProperty({ enum: TEMPLATE_TYPES })
  type!: string;

  @IsIn(LANGUAGES)
  @ApiProperty({ enum: LANGUAGES })
  language!: string;

  /** A subject document (contracts/template-vectors.json); markup in its place is refused. */
  @IsDefined()
  @ApiProperty({ type: 'object', additionalProperties: true })
  subject!: unknown;

  /** A body document (contracts/template-vectors.json); markup in its place is refused. */
  @IsDefined()
  @ApiProperty({ type: 'object', additionalProperties: true })
  body!: unknown;

  @IsOptional()
  @IsUUID('4')
  mailServerId?: string | null;
}

/** A change of a template's documents (and its mail server), with the version it was read at. */
export class UpdateMailTemplateDto {
  @IsDefined()
  @ApiProperty({ type: 'object', additionalProperties: true })
  subject!: unknown;

  @IsDefined()
  @ApiProperty({ type: 'object', additionalProperties: true })
  body!: unknown;

  /** Null removes the template's own server; left out, it stays. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  mailServerId?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** A sample render by the server (FR-MAIL-02): the documents as the editor holds them, not saved. */
export class TemplatePreviewRequestDto {
  @IsIn(TEMPLATE_TYPES)
  @ApiProperty({ enum: TEMPLATE_TYPES })
  type!: string;

  @IsIn(LANGUAGES)
  @ApiProperty({ enum: LANGUAGES })
  language!: string;

  /** The conference whose name the sample shows; the organisation's otherwise. */
  @IsOptional()
  @IsUUID('4')
  conferenceId?: string;

  @IsDefined()
  @ApiProperty({ type: 'object', additionalProperties: true })
  subject!: unknown;

  @IsDefined()
  @ApiProperty({ type: 'object', additionalProperties: true })
  body!: unknown;
}

/**
 * The sample render: sample values for every placeholder, every condition holding, the
 * images embedded as data. Shown only in a sandboxed frame without scripts or same-origin.
 */
export class TemplatePreviewDto {
  subject!: string;
  html!: string;
  text!: string;
  /** Images of the body not shown yet: their virus scan is not clean (yet). */
  imagesPending!: string[];
}

/** Which template a type and language of a conference uses, by the fallback of ADR-12. */
export class EffectiveTemplateDto {
  type!: string;
  language!: string;
  /** `conference`, `conference_en` (its English one), `organisation`, `organisation_en`, or `none`. */
  @ApiProperty({
    enum: ['conference', 'conference_en', 'organisation', 'organisation_en', 'none'],
  })
  source!: 'conference' | 'conference_en' | 'organisation' | 'organisation_en' | 'none';
  templateId!: string | null;
}

export class EffectiveTemplateListDto {
  items!: EffectiveTemplateDto[];
}

export class EffectiveTemplateQueryDto {
  /** Without it, the organisation's own. */
  @IsOptional()
  @IsUUID('4')
  conferenceId?: string;
}

/** One status email of a conference and whether it is sent (FR-MAIL-07). */
export class StatusEmailSwitchDto {
  @IsIn(STATUS_TEMPLATE_TYPES)
  @ApiProperty({ enum: STATUS_TEMPLATE_TYPES })
  type!: string;

  @IsBoolean()
  enabled!: boolean;
}

/** The status emails of a conference: all on by default; an off one sends nothing. */
export class StatusEmailsDto {
  conferenceId!: string;
  types!: StatusEmailSwitchDto[];
  /** The version of the conference. */
  version!: number;
}

export class StatusEmailsUpdateDto {
  @IsArray()
  @ArrayMaxSize(STATUS_TEMPLATE_TYPES.length)
  @ValidateNested({ each: true })
  @Type(() => StatusEmailSwitchDto)
  types!: StatusEmailSwitchDto[];

  /** The version of the conference. */
  @IsInt()
  @Min(1)
  version!: number;
}
