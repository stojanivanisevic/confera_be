import { Body, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { notBefore, RESET_REQUEST_FLOOR_MS, startClock } from '../../common/http/answer-floor';
import { clientAddress } from '../../common/http/client-address';
import { AdminController } from '../../common/http/surface';
import { CurrentAccess, Permission, Public } from './access.decorators';
import {
  ChangeEmailDto,
  ChangePasswordDto,
  EmailChangeLinkDto,
  LinkPersonDto,
  ResetRequestDto,
  SetPasswordDto,
} from './access.dto';
import { AccountService } from './account.service';
import { clearCookie, SESSION_COOKIE } from './cookies';
import type { SessionState } from './session.service';

/**
 * The person's own account, and the pages behind secure links (ADR-03, ADR-04; FR-USR-02,
 * FR-USR-03, FR-USR-06; ST-15 to ST-18).
 *
 * A link's token is in the path. Opening it (GET) changes nothing; the action is a POST
 * that uses the link up. Each path accepts exactly one purpose: an invitation token on the
 * reset path is not found, and so on. Every failure of a link answers 404 `link_invalid`,
 * whatever the reason.
 */
@AdminController('')
export class AccountController {
  constructor(private readonly accounts: AccountService) {}

  /**
   * Changes the own password; needs the current one. Ends every other session of the user,
   * and tells every active admin. A new password that breaks a rule is refused with 400
   * `password_refused` and each broken rule named (`password_length`, `password_common`,
   * `password_personal`, `password_mismatch`).
   */
  @Post('account/password')
  @Permission('account.manage')
  @HttpCode(204)
  async changePassword(
    @CurrentAccess() access: SessionState,
    @Body() body: ChangePasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.accounts.changePassword(
      access,
      body.currentPassword,
      body.newPassword,
      body.newPasswordRepeat,
      clientAddress(request),
    );
  }

  /**
   * Asks for an email change; needs the current password. A link to confirm it goes to the
   * new address, a notice to the old one and to every active admin. 409 `email_taken` when
   * the address belongs to an account already.
   */
  @Post('account/email')
  @Permission('account.manage')
  @HttpCode(202)
  async changeEmail(
    @CurrentAccess() access: SessionState,
    @Body() body: ChangeEmailDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.accounts.requestEmailChange(
      access,
      body.password,
      body.newEmail,
      clientAddress(request),
    );
  }

  /**
   * Asks for a password reset. The answer is 202 and nothing else, for every address, after
   * the same time: whether an account has it, is active, is in the cool-down of an earlier
   * request or has reached its daily cap, is not told.
   */
  @Post('password-resets')
  @Public()
  @HttpCode(202)
  async requestReset(@Body() body: ResetRequestDto, @Req() request: Request): Promise<void> {
    const started = startClock();
    await this.accounts.requestReset(body.email, clientAddress(request));
    await notBefore(started, RESET_REQUEST_FLOOR_MS);
  }

  /** The page of a reset link: whose account it is, for the password checklist. Uses nothing up. */
  @Get('password-resets/:token')
  @Public()
  async openReset(@Param('token') token: string, @Req() request: Request): Promise<LinkPersonDto> {
    const link = await this.accounts.openLink(token, 'password_reset', clientAddress(request));
    return this.person(await this.accounts.linkPerson(link));
  }

  /** Sets a new password through a reset link, and uses the link up. Ends every session of the user. */
  @Post('password-resets/:token')
  @Public()
  @HttpCode(204)
  async completeReset(
    @Param('token') token: string,
    @Body() body: SetPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const link = await this.accounts.openLink(token, 'password_reset', clientAddress(request));
    await this.accounts.setPasswordByLink(link, body.password, body.passwordRepeat);
    clearCookie(response, SESSION_COOKIE);
  }

  /** The page of an invitation link: whose account it is, for the password checklist. Uses nothing up. */
  @Get('invitations/:token')
  @Public()
  async openInvitation(
    @Param('token') token: string,
    @Req() request: Request,
  ): Promise<LinkPersonDto> {
    const link = await this.accounts.openLink(token, 'invitation', clientAddress(request));
    return this.person(await this.accounts.linkPerson(link));
  }

  /** Accepts an invitation: sets the password, makes the account active, uses the link up. */
  @Post('invitations/:token')
  @Public()
  @HttpCode(204)
  async acceptInvitation(
    @Param('token') token: string,
    @Body() body: SetPasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    const link = await this.accounts.openLink(token, 'invitation', clientAddress(request));
    await this.accounts.setPasswordByLink(link, body.password, body.passwordRepeat);
  }

  /** The page of an email-change link: the address the account will have. Uses nothing up. */
  @Get('email-changes/:token')
  @Public()
  async openEmailChange(
    @Param('token') token: string,
    @Req() request: Request,
  ): Promise<EmailChangeLinkDto> {
    const link = await this.accounts.openLink(token, 'email_change', clientAddress(request));
    return { newEmail: link.recipient, expiresAt: link.expiresAt.toISOString() };
  }

  /** Confirms an email change from the new address. Ends every session of the user. */
  @Post('email-changes/:token')
  @Public()
  @HttpCode(204)
  async confirmEmailChange(
    @Param('token') token: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const link = await this.accounts.openLink(token, 'email_change', clientAddress(request));
    await this.accounts.confirmEmailChange(link);
    clearCookie(response, SESSION_COOKIE);
  }

  private person(person: {
    email?: string | undefined;
    displayName?: string | undefined;
    organisationName?: string | undefined;
    expiresAt: Date;
  }): LinkPersonDto {
    return {
      email: person.email ?? '',
      displayName: person.displayName ?? '',
      organisationName: person.organisationName ?? '',
      expiresAt: person.expiresAt.toISOString(),
    };
  }
}
