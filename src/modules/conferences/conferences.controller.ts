import { Body, Get, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AdminController } from '../../common/http/surface';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import {
  ConferenceDto,
  ConferenceListDto,
  ConferenceQueryDto,
  ConferenceStateDto,
  CopyConferenceDto,
  CreateConferenceDto,
  UpdateConferenceDto,
} from './conferences.dto';
import { ConferencesService } from './conferences.service';

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

/**
 * Conferences of the organisation (FR-CONF-01 to 04; ST-30). A taken code and edition is
 * 409 `conference_code_taken`; a change of an archived conference 409 `conference_archived`;
 * a change of state that FR-CONF-04 does not allow 409 `state_change_not_allowed`.
 */
@AdminController('conferences')
export class ConferencesController {
  constructor(private readonly conferences: ConferencesService) {}

  @Get()
  @Permission('conferences.read')
  async listConferences(@Query() query: ConferenceQueryDto): Promise<ConferenceListDto> {
    return { items: await this.conferences.list(query.state) };
  }

  @Get(':id')
  @Permission('conferences.read')
  getConference(@Param('id', ID) id: string): Promise<ConferenceDto> {
    return this.conferences.get(id);
  }

  @Post()
  @Permission('conferences.manage')
  createConference(
    @CurrentAccess() access: Access,
    @Body() body: CreateConferenceDto,
  ): Promise<ConferenceDto> {
    return this.conferences.create(access, body);
  }

  @Patch(':id')
  @Permission('conferences.manage')
  updateConference(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: UpdateConferenceDto,
  ): Promise<ConferenceDto> {
    return this.conferences.update(access, id, body);
  }

  @Post(':id/state')
  @Permission('conferences.manage')
  changeConferenceState(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: ConferenceStateDto,
  ): Promise<ConferenceDto> {
    return this.conferences.changeState(access, id, body.state, body.version);
  }

  /** A new draft as a copy of this conference (FR-CONF-03). */
  @Post(':id/copy')
  @Permission('conferences.manage')
  copyConference(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: CopyConferenceDto,
  ): Promise<ConferenceDto> {
    return this.conferences.copy(access, id, body);
  }
}
