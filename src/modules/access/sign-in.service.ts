import { Injectable } from '@nestjs/common';
import { SystemResolvers } from '../../platform/prisma/system/resolvers';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { AuditRecorder } from '../audit/audit-recorder';
import { MailQueue } from '../mail/mail-queue';
import { BrakeService, type Attempt } from './brake.service';
import { PasswordHasher } from './password-hasher';
import { type NewSession, SessionService } from './session.service';
import { digestOf, newToken } from './tokens';

/** At most one notice of the brake to the owner of an account per day (ADR-03, SEC-A-14). */
const BRAKE_NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;

export interface SignInRequest {
  readonly email: string;
  readonly password: string;
  readonly clientAddress: string;
  /** The token of the device cookie the browser sent, if any. */
  readonly deviceToken: string | null;
  /** The session cookie the browser sent, if any: it is ended, and a new one made. */
  readonly sessionToken: string | null;
}

export type SignInResult =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly session: NewSession;
      readonly organisationId: string;
      /** A new device token, when this browser was not a known device of the account. */
      readonly newDeviceToken: string | null;
    };

/**
 * Sign-in (ADR-03, FR-USR-03, NFR-SEC-07; ST-14, ST-15, ST-16).
 *
 * The answer is the same for an unknown address, a wrong password, a braked account or
 * address, a deactivated, an invited and a removed account: `{ ok: false }`, after exactly
 * one argon2 check of the password (against the account's hash, or a hash of nothing), and
 * the controller holds every answer to the same floor of time.
 */
@Injectable()
export class SignInService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
    private readonly hasher: PasswordHasher,
    private readonly brake: BrakeService,
    private readonly sessions: SessionService,
    private readonly audit: AuditRecorder,
    private readonly mail: MailQueue,
  ) {}

  async signIn(request: SignInRequest): Promise<SignInResult> {
    const email = request.email.trim();
    const resolved = email === '' ? null : await this.resolvers.userByEmail(email);

    // What the account is, inside its organisation: state, hash, and whether this browser
    // is a known device of it.
    const account =
      resolved === null
        ? null
        : await this.context.run(resolved.organisationId, async () => {
            const user = await this.database.db.user.findUnique({
              where: { id: resolved.userId },
              select: { status: true, passwordHash: true, email: true },
            });
            const device =
              request.deviceToken === null
                ? null
                : await this.database.db.knownDevice.findUnique({
                    where: {
                      organisationId_userId_tokenHash: {
                        organisationId: resolved.organisationId,
                        userId: resolved.userId,
                        tokenHash: digestOf(request.deviceToken),
                      },
                    },
                    select: { id: true },
                  });
            return user === null ? null : { ...user, deviceId: device?.id ?? null };
          });

    const attempt: Attempt = {
      clientAddress: request.clientAddress,
      user: resolved,
      knownDevice: account !== null && account.deviceId !== null,
    };
    const brake = await this.brake.state(attempt);
    if (brake.addressBraked || brake.accountBraked) {
      // Too early: answered as a failure without looking at the password, and not counted.
      await this.hasher.matches(null, request.password);
      if (brake.accountBraked && resolved !== null && account !== null) {
        await this.noticeBrake(resolved, account.email);
      }
      return { ok: false };
    }

    const active = account !== null && account.status === 'active';
    const matches = await this.hasher.matches(
      active ? account.passwordHash : null,
      request.password,
    );
    if (!matches || resolved === null || account === null) {
      await this.brake.recordFailure('sign_in_failed', attempt);
      if (resolved !== null) {
        await this.context.run(resolved.organisationId, () =>
          this.database.transaction((tx) =>
            this.audit.record(tx, {
              organisationId: resolved.organisationId,
              actorUserId: null,
              action: 'session.sign_in_failed',
              subjectType: 'user',
              subjectId: resolved.userId,
            }),
          ),
        );
      }
      return { ok: false };
    }

    return this.context.run(resolved.organisationId, () =>
      this.database.transaction(async (tx) => {
        if (request.sessionToken !== null) {
          // A new id at every sign-in: the session this browser had ends.
          const previous = await this.sessions.find(request.sessionToken);
          if (previous !== null && previous.organisationId === resolved.organisationId) {
            await this.sessions.end(tx, previous.sessionId, 'signed_in_again');
          }
        }
        let deviceId = account.deviceId;
        let newDeviceToken: string | null = null;
        if (deviceId === null) {
          newDeviceToken = newToken();
          const device = await tx.knownDevice.create({
            data: {
              organisationId: resolved.organisationId,
              userId: resolved.userId,
              tokenHash: digestOf(newDeviceToken),
            },
            select: { id: true },
          });
          deviceId = device.id;
          // A sign-in from a new device is announced to every active admin (ADR-03, ST-19).
          await this.mail.noticeToAdmins(tx, resolved.organisationId, 'new_device_sign_in', {
            subjectUserId: resolved.userId,
          });
        } else {
          await tx.knownDevice.update({
            where: { id: deviceId },
            data: { lastUsedAt: new Date() },
          });
        }
        const session = await this.sessions.create(tx, resolved, deviceId);
        await this.audit.record(tx, {
          organisationId: resolved.organisationId,
          actorUserId: resolved.userId,
          action: 'session.signed_in',
          subjectType: 'user',
          subjectId: resolved.userId,
          detail: { newDevice: newDeviceToken !== null },
        });
        return { ok: true, session, organisationId: resolved.organisationId, newDeviceToken };
      }),
    );
  }

  /** Tells the owner that the brake slows the account down: at most once a day. */
  private async noticeBrake(
    resolved: { organisationId: string; userId: string },
    address: string,
  ): Promise<void> {
    await this.context.run(resolved.organisationId, () =>
      this.database.transaction(async (tx) => {
        const since = new Date(Date.now() - BRAKE_NOTICE_EVERY_MS);
        if ((await this.mail.countSince(tx, resolved.userId, 'sign_in_brake', since)) > 0) {
          return;
        }
        // One per account and day, also when two requests arrive at once.
        const day = new Date().toISOString().slice(0, 10);
        await this.mail.enqueue(tx, {
          organisationId: resolved.organisationId,
          kind: 'sign_in_brake',
          recipientUserId: resolved.userId,
          recipientAddress: address,
          uniqueKey: `sign_in_brake:${resolved.userId}:${day}`,
        });
      }),
    );
  }
}
