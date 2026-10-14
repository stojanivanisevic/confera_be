import { Body, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { notBefore, SIGN_IN_FLOOR_MS, startClock } from '../../common/http/answer-floor';
import { clientAddress } from '../../common/http/client-address';
import { ProblemException } from '../../common/http/problem';
import { AdminController } from '../../common/http/surface';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { AuditRecorder } from '../audit/audit-recorder';
import { CurrentAccess, Permission, Public } from './access.decorators';
import { ConfirmationDto, PasswordConfirmationDto, SessionDto, SignInDto } from './access.dto';
import { AccountService } from './account.service';
import {
  clearCookie,
  cookieValue,
  DEVICE_COOKIE,
  DEVICE_COOKIE_SECONDS,
  SESSION_COOKIE,
  setCookie,
} from './cookies';
import { ABSOLUTE_MS, SessionService, type SessionState } from './session.service';
import { SignInService } from './sign-in.service';
import { csrfValueOf } from './tokens';

/**
 * Sign-in, the session and sign-out (ADR-03, FR-USR-03; ST-13, ST-14, ST-16, ST-61).
 *
 *   POST   /api/v1/session                         sign in
 *   GET    /api/v1/session                         the signed-in user and the CSRF value
 *   DELETE /api/v1/session                         sign out (this session)
 *   DELETE /api/v1/sessions                        sign out everywhere (every session of the user)
 *   POST   /api/v1/session/password-confirmation   the password asked again (valid 5 minutes)
 */
@AdminController('')
export class SessionController {
  constructor(
    private readonly signIns: SignInService,
    private readonly sessions: SessionService,
    private readonly accounts: AccountService,
    private readonly database: TenantDatabase,
    private readonly context: TenantContext,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * Signs in. Every failure answers alike (401 `sign_in_failed`), after the same time: an
   * unknown address, a wrong password, a braked account or address, an account that is
   * deactivated, invited or removed. Sets the session cookie and, for a browser that was
   * not a known device of the account, the device cookie.
   */
  @Post('session')
  @Public()
  @HttpCode(200)
  async signIn(
    @Body() body: SignInDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const started = startClock();
    const result = await this.signIns.signIn({
      email: body.email,
      password: body.password,
      clientAddress: clientAddress(request),
      deviceToken: cookieValue(request, DEVICE_COOKIE),
      sessionToken: cookieValue(request, SESSION_COOKIE),
    });
    const state = result.ok
      ? await this.sessions.authenticate(result.session.token, { renew: false })
      : null;
    await notBefore(started, SIGN_IN_FLOOR_MS);
    if (!result.ok || state === null) {
      throw new ProblemException(401, 'sign_in_failed');
    }
    setCookie(response, SESSION_COOKIE, result.session.token, ABSOLUTE_MS / 1000);
    if (result.newDeviceToken !== null) {
      setCookie(response, DEVICE_COOKIE, result.newDeviceToken, DEVICE_COOKIE_SECONDS);
    }
    return this.describe(state);
  }

  /**
   * The signed-in user, the organisation and the CSRF value of the session. A request with
   * the header `X-Confera-Background` (a refetch the person did not ask for) does not renew
   * the session.
   */
  @Get('session')
  @Permission('account.manage')
  async getSession(@CurrentAccess() access: SessionState): Promise<SessionDto> {
    return this.describe(access);
  }

  /** Signs out: ends this session on the server and clears its cookie. */
  @Delete('session')
  @Permission('account.manage')
  @HttpCode(204)
  async signOut(
    @CurrentAccess() access: SessionState,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.sessions.end(tx, access.sessionId, 'signed_out');
      await this.audit.record(tx, {
        organisationId: access.organisationId,
        actorUserId: access.userId,
        action: 'session.signed_out',
        subjectType: 'user',
        subjectId: access.userId,
      });
    });
    clearCookie(response, SESSION_COOKIE);
  }

  /** Signs out everywhere: ends every session of the user, this one included. */
  @Delete('sessions')
  @Permission('account.manage')
  @HttpCode(204)
  async signOutEverywhere(
    @CurrentAccess() access: SessionState,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.sessions.endAllOf(tx, access.userId, 'signed_out_everywhere');
      await this.audit.record(tx, {
        organisationId: access.organisationId,
        actorUserId: access.userId,
        action: 'session.signed_out_everywhere',
        subjectType: 'user',
        subjectId: access.userId,
      });
    });
    clearCookie(response, SESSION_COOKIE);
  }

  /**
   * The password asked again before a sensitive change (ADR-03): valid for 5 minutes, in
   * this session only. A wrong password answers 403 `password_incorrect` and counts for the
   * brake of the account.
   */
  @Post('session/password-confirmation')
  @Permission('account.manage')
  @HttpCode(200)
  async confirmPassword(
    @CurrentAccess() access: SessionState,
    @Body() body: PasswordConfirmationDto,
    @Req() request: Request,
  ): Promise<ConfirmationDto> {
    const until = await this.accounts.confirmPassword(
      access,
      body.password,
      clientAddress(request),
    );
    return { confirmationValidUntil: until.toISOString() };
  }

  private async describe(state: SessionState): Promise<SessionDto> {
    const user = await this.context.run(state.organisationId, () =>
      this.database.db.user.findUniqueOrThrow({
        where: { id: state.userId },
        select: {
          id: true,
          email: true,
          displayName: true,
          organisation: { select: { id: true, name: true } },
        },
      }),
    );
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: [...state.roles],
        permissions: [...state.permissions].sort(),
      },
      organisation: { id: user.organisation.id, name: user.organisation.name },
      csrf: csrfValueOf(state.sessionToken),
      idleExpiresAt: state.idleExpiresAt.toISOString(),
      absoluteExpiresAt: state.absoluteExpiresAt.toISOString(),
      confirmationValidUntil: state.confirmationValidUntil?.toISOString() ?? null,
      secondFactor: state.secondFactor,
    };
  }
}
