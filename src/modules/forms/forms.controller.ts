import {
  Body,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { AdminController } from '../../common/http/surface';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import {
  CreateFormDto,
  FormBreakerDto,
  FormDraftDto,
  FormDto,
  FormListDto,
  FormQueryDto,
  FormVersionDto,
  FormVersionRefDto,
} from './forms.dto';
import { FormsService } from './forms.service';

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });
const NUMBER = new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

/**
 * The forms of the conferences (M3-BE-01, FR-FORM-01, FR-FORM-02). A change of a draft that
 * the catalogue does not allow is 400 `validation_failed` with `configuration.<path>`; a
 * second form of a type for a conference 409 `form_exists`; an older version 409
 * `version_conflict`.
 */
@AdminController('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  @Permission('forms.read')
  async listForms(@Query() query: FormQueryDto): Promise<FormListDto> {
    return { items: await this.forms.list(query.conferenceId) };
  }

  @Get(':id')
  @Permission('forms.read')
  getForm(@Param('id', ID) id: string): Promise<FormDto> {
    return this.forms.get(id);
  }

  /** The draft: the configuration over the catalogue (contracts/form-configuration.schema.json). */
  @Put(':id/draft')
  @Permission('forms.manage')
  saveFormDraft(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: FormDraftDto,
  ): Promise<FormDto> {
    return this.forms.saveDraft(access, id, body.configuration, body.version);
  }

  /** Publishes the draft as a new version; the public form shows it from the next load. */
  @Post(':id/publish')
  @Permission('forms.manage')
  publishForm(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: FormVersionRefDto,
  ): Promise<FormDto> {
    return this.forms.publish(access, id, body.version);
  }

  /** The send breaker of the form (ADR-08, M3-BE-09). */
  @Patch(':id/breaker')
  @Permission('forms.manage')
  setFormBreaker(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: FormBreakerDto,
  ): Promise<FormDto> {
    return this.forms.setBreaker(access, id, body);
  }

  /** A published version: the definition its submissions were made with. */
  @Get(':id/versions/:number')
  @Permission('forms.read')
  getFormVersion(
    @Param('id', ID) id: string,
    @Param('number', NUMBER) number: number,
  ): Promise<FormVersionDto> {
    return this.forms.version(id, number);
  }
}

/** A form of a type for a conference: `POST /api/v1/conferences/{id}/forms`. */
@AdminController('conferences')
export class ConferenceFormsController {
  constructor(private readonly forms: FormsService) {}

  @Post(':id/forms')
  @Permission('forms.manage')
  createForm(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: CreateFormDto,
  ): Promise<FormDto> {
    return this.forms.create(access, id, body.type);
  }
}
