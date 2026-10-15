import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AdminController } from '../../common/http/surface';
import type { Access } from '../access/access';
import { CurrentAccess, FreshPassword, Permission } from '../access/access.decorators';
import {
  CreateMailServerDto,
  MailServerDto,
  MailServerListDto,
  MailServerVersionQueryDto,
  TestMessageDto,
  TestMessageResultDto,
  UpdateMailServerDto,
} from './mail-servers.dto';
import { MailServersService } from './mail-servers.service';

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

/**
 * Outgoing mail servers of the organisation (FR-SMTP-01 to 03, ADR-11; ST-19, ST-20).
 * Every change asks for the password again (403 `password_confirmation_required` without
 * it) and tells every active admin. A target that breaks a rule of ADR-11 is refused with
 * 422 `tls_required`, `port_not_allowed` or `address_not_allowed`.
 */
@AdminController('mail-servers')
export class MailServersController {
  constructor(private readonly servers: MailServersService) {}

  @Get()
  @Permission('mail_servers.read')
  async listMailServers(): Promise<MailServerListDto> {
    return { items: await this.servers.list() };
  }

  @Get(':id')
  @Permission('mail_servers.read')
  getMailServer(@Param('id', ID) id: string): Promise<MailServerDto> {
    return this.servers.get(id);
  }

  @Post()
  @Permission('mail_servers.manage')
  @FreshPassword()
  createMailServer(
    @CurrentAccess() access: Access,
    @Body() body: CreateMailServerDto,
  ): Promise<MailServerDto> {
    return this.servers.create(access, body);
  }

  /** 409 `version_conflict` when another admin changed it first. */
  @Patch(':id')
  @Permission('mail_servers.manage')
  @FreshPassword()
  updateMailServer(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: UpdateMailServerDto,
  ): Promise<MailServerDto> {
    return this.servers.update(access, id, body);
  }

  /** 409 `mail_server_in_use` while a conference or a template names it. */
  @Delete(':id')
  @Permission('mail_servers.manage')
  @FreshPassword()
  @HttpCode(204)
  async deleteMailServer(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Query() query: MailServerVersionQueryDto,
  ): Promise<void> {
    await this.servers.remove(access, id, query.version);
  }

  /** Sends a test message through this server to one address; the result is generic. */
  @Post(':id/test-message')
  @Permission('mail_servers.manage')
  @HttpCode(200)
  sendTestMessage(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: TestMessageDto,
  ): Promise<TestMessageResultDto> {
    return this.servers.test(access, id, body.to, body.language ?? 'en');
  }
}
