import { Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { Permission } from '../access/access.decorators';
import { CONDITIONS, LANGUAGES, PLACEHOLDERS, TEMPLATE_TYPES } from './placeholders';
import {
  MailTemplateDto,
  MailTemplateListDto,
  MailTemplateQueryDto,
  TemplateCatalogueDto,
} from './templates.dto';

function toDto(row: Prisma.MailTemplateGetPayload<object>): MailTemplateDto {
  return {
    id: row.id,
    conferenceId: row.conferenceId,
    type: row.type,
    language: row.language,
    subject: row.subject as Record<string, unknown>,
    body: row.body as Record<string, unknown>,
    mailServerId: row.mailServerId,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

/**
 * The email templates, read only in 0.2.0 (ADR-12, FR-MAIL-01 and 02): what the editor of
 * M2-FE-05 shows. Editing arrives with 0.4.0.
 */
@AdminController('mail-templates')
export class TemplatesController {
  constructor(private readonly database: TenantDatabase) {}

  /** The placeholder catalogue per type: what a template of the type may use. */
  @Get('catalogue')
  @Permission('templates.read')
  getTemplateCatalogue(): TemplateCatalogueDto {
    return {
      types: TEMPLATE_TYPES.map((type) => ({
        type,
        placeholders: PLACEHOLDERS[type].filter((key) => key !== 'link'),
        conditions: [...CONDITIONS[type]],
        carriesLink: PLACEHOLDERS[type].includes('link'),
      })),
      languages: [...LANGUAGES],
    };
  }

  @Get()
  @Permission('templates.read')
  async listMailTemplates(@Query() query: MailTemplateQueryDto): Promise<MailTemplateListDto> {
    const rows = await this.database.db.mailTemplate.findMany({
      where: {
        conferenceId: query.conferenceId ?? null,
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.language === undefined ? {} : { language: query.language }),
      },
      orderBy: [{ type: 'asc' }, { language: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(toDto) };
  }

  @Get(':id')
  @Permission('templates.read')
  async getMailTemplate(
    @Param('id', new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND }))
    id: string,
  ): Promise<MailTemplateDto> {
    const row = await this.database.db.mailTemplate.findUnique({ where: { id } });
    if (row === null) {
      throw new ProblemException(404, 'not_found');
    }
    return toDto(row);
  }
}
