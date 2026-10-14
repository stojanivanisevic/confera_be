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
  Put,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { AdminController } from '../../common/http/surface';
import { CurrentAccess, FreshPassword, Permission } from '../access/access.decorators';
import type { Access } from '../access/access';
import type { RoleName } from '../access/permissions';
import {
  ChangeRoleDto,
  InviteUserDto,
  UpdateUserDto,
  UserDto,
  UserPageDto,
  UserQueryDto,
  VersionDto,
} from './users.dto';
import { UsersService } from './users.service';

export class RemoveUserQueryDto {
  /** The version the removal is made on. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

/**
 * Users of the organisation (FR-USR-01, FR-USR-02, FR-USR-04; ST-19). Every change of a
 * user or a role asks for the password again (`@FreshPassword`: 403
 * `password_confirmation_required` without it) and tells every active admin.
 */
@AdminController('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** The users, a page at a time; the removed ones only when asked for by state. */
  @Get()
  @Permission('users.read')
  listUsers(@Query() query: UserQueryDto): Promise<UserPageDto> {
    return this.users.list(query);
  }

  @Get(':id')
  @Permission('users.read')
  getUser(@Param('id', ID) id: string): Promise<UserDto> {
    return this.users.get(id);
  }

  /** Invites a user: the invitation goes to the address. 409 `email_taken` when it has an account. */
  @Post()
  @Permission('users.manage')
  @FreshPassword()
  inviteUser(@CurrentAccess() access: Access, @Body() body: InviteUserDto): Promise<UserDto> {
    return this.users.invite(access, {
      email: body.email,
      displayName: body.displayName,
      role: body.role as RoleName,
    });
  }

  @Patch(':id')
  @Permission('users.manage')
  @FreshPassword()
  updateUser(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: UpdateUserDto,
  ): Promise<UserDto> {
    return this.users.update(access, id, body.displayName, body.version);
  }

  /** Changes the role; ends the user's sessions. 409 `last_admin` for the last active admin. */
  @Put(':id/role')
  @Permission('users.manage')
  @FreshPassword()
  changeRole(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: ChangeRoleDto,
  ): Promise<UserDto> {
    return this.users.changeRole(access, id, body.role as RoleName, body.version);
  }

  /** Deactivates: the user cannot sign in, and the sessions end. 409 `last_admin` for the last active admin. */
  @Post(':id/deactivation')
  @Permission('users.manage')
  @FreshPassword()
  @HttpCode(200)
  deactivateUser(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: VersionDto,
  ): Promise<UserDto> {
    return this.users.deactivate(access, id, body.version);
  }

  @Post(':id/reactivation')
  @Permission('users.manage')
  @FreshPassword()
  @HttpCode(200)
  reactivateUser(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: VersionDto,
  ): Promise<UserDto> {
    return this.users.reactivate(access, id, body.version);
  }

  /** Removes a user; past actions stay attributed. 409 `last_admin` for the last active admin. */
  @Delete(':id')
  @Permission('users.manage')
  @FreshPassword()
  @HttpCode(204)
  async removeUser(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Query() query: RemoveUserQueryDto,
  ): Promise<void> {
    await this.users.remove(access, id, query.version);
  }

  /** Sends the invitation again, with a new link that ends the earlier one. */
  @Post(':id/invitation')
  @Permission('users.manage')
  @FreshPassword()
  @HttpCode(202)
  resendInvitation(@CurrentAccess() access: Access, @Param('id', ID) id: string): Promise<UserDto> {
    return this.users.resendInvitation(access, id);
  }

  /** Ends every session of the user (an admin's "end this user's sessions", ADR-03). */
  @Delete(':id/sessions')
  @Permission('users.manage')
  @FreshPassword()
  @HttpCode(204)
  async endUserSessions(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
  ): Promise<void> {
    await this.users.endUserSessions(access, id);
  }
}
