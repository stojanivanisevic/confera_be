import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { AdminController } from '../../common/http/surface';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import { STATUS_TEMPLATE_TYPES } from '../submissions/status-machine';
import { CONDITIONS, LANGUAGES, PLACEHOLDERS, TEMPLATE_TYPES } from './placeholders';
import {
  CreateMailTemplateDto,
  EffectiveTemplateListDto,
  EffectiveTemplateQueryDto,
  MailTemplateDto,
  MailTemplateListDto,
  MailTemplateQueryDto,
  StatusEmailsDto,
  StatusEmailsUpdateDto,
  TemplateCatalogueDto,
  TemplatePreviewDto,
  TemplatePreviewRequestDto,
  UpdateMailTemplateDto,
} from './templates.dto';
import { TemplatesService, toTemplateDto } from './templates.service';

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

/**
 * The email templates (ADR-12, FR-MAIL-01 and 02, M4-BE-03): the catalogue of each type, the
 * templates of the organisation and the overrides of a conference, a version per language,
 * edited by the visual editor and checked on save, and the sample render by the server.
 */
@AdminController('mail-templates')
export class TemplatesController {
  constructor(
    private readonly database: TenantDatabase,
    private readonly templates: TemplatesService,
  ) {}

  /** The placeholder catalogue per type: what a template of the type may use. */
  @Get('catalogue')
  @Permission('templates.read')
  getTemplateCatalogue(): TemplateCatalogueDto {
    return {
      types: TEMPLATE_TYPES.map((type) => ({
        type,
        statusEmail: (STATUS_TEMPLATE_TYPES as readonly string[]).includes(type),
        placeholders: PLACEHOLDERS[type].filter((key) => key !== 'link'),
        conditions: [...CONDITIONS[type]],
        carriesLink: PLACEHOLDERS[type].includes('link'),
      })),
      languages: [...LANGUAGES],
    };
  }

  /**
   * Which template every type and language uses for a conference (or for the organisation),
   * by the fallback of ADR-12: conference and language, conference in English, organisation
   * and language, organisation in English.
   */
  @Get('effective')
  @Permission('templates.read')
  async listEffectiveTemplates(
    @Query() query: EffectiveTemplateQueryDto,
  ): Promise<EffectiveTemplateListDto> {
    return { items: await this.templates.effective(query.conferenceId ?? null) };
  }

  /** The sample render of a template as the editor holds it (FR-MAIL-02). Nothing is saved. */
  @Post('preview')
  @Permission('templates.read')
  @HttpCode(200)
  previewMailTemplate(@Body() body: TemplatePreviewRequestDto): Promise<TemplatePreviewDto> {
    return this.templates.preview(body);
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
    return { items: rows.map(toTemplateDto) };
  }

  /** A language version of the organisation, or the override of a conference. */
  @Post()
  @Permission('templates.manage')
  createMailTemplate(
    @CurrentAccess() access: Access,
    @Body() body: CreateMailTemplateDto,
  ): Promise<MailTemplateDto> {
    return this.templates.create(access, body);
  }

  @Get(':id')
  @Permission('templates.read')
  async getMailTemplate(@Param('id', ID) id: string): Promise<MailTemplateDto> {
    const row = await this.database.db.mailTemplate.findUnique({ where: { id } });
    if (row === null) {
      throw new ProblemException(404, 'not_found');
    }
    return toTemplateDto(row);
  }

  /** A change of a template, checked like a new one; 409 `version_conflict` on a stale version. */
  @Put(':id')
  @Permission('templates.manage')
  updateMailTemplate(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: UpdateMailTemplateDto,
  ): Promise<MailTemplateDto> {
    return this.templates.update(access, id, body);
  }

  /**
   * Removes the override of a conference: its emails use the organisation's again. The
   * organisation's own templates are never removed (409 `organisation_template`).
   */
  @Delete(':id')
  @Permission('templates.manage')
  @HttpCode(204)
  async deleteMailTemplate(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
  ): Promise<void> {
    await this.templates.remove(access, id);
  }
}

/** The status emails of a conference, on or off (FR-MAIL-07). */
@AdminController('conferences')
export class StatusEmailsController {
  constructor(private readonly templates: TemplatesService) {}

  @Get(':id/status-emails')
  @Permission('templates.read')
  getStatusEmails(@Param('id', ID) id: string): Promise<StatusEmailsDto> {
    return this.templates.statusEmails(id);
  }

  /**
   * Switches status emails of the conference off or on. A change of status whose email is
   * off sends nothing; its history says "no email: template off".
   */
  @Put(':id/status-emails')
  @Permission('templates.manage')
  setStatusEmails(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: StatusEmailsUpdateDto,
  ): Promise<StatusEmailsDto> {
    return this.templates.setStatusEmails(access, id, body);
  }
}
