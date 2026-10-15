import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { LANGUAGES, TEMPLATE_TYPES } from './placeholders';

/** The placeholders and conditions one template type may use (ADR-12, FR-MAIL-02). */
export class TemplateTypeDto {
  type!: string;
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
