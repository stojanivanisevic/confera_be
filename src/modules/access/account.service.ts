import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { RateLimiter } from '../../common/http/rate-limiter';
import { ProblemException } from '../../common/http/problem';
import { SystemResolvers } from '../../platform/prisma/system/resolvers';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { AuditRecorder } from '../audit/audit-recorder';
import { type LinkPurpose, type OpenLink, SecureLinks } from '../links/secure-links';
import { MailQueue } from '../mail/mail-queue';
import { BrakeService } from './brake.service';
import { PasswordHasher } from './password-hasher';
import { type PasswordContext, passwordProblems } from './password-rules';
import { SessionService } from './session.service';

/** A second reset request within this time does nothing (ADR-04): the first link stays valid. */
export const RESET_COOL_DOWN_MS = 15 * 60 * 1000;
/** At most this many reset messages to one account in a day (ADR-04). */
export const RESET_DAILY_CAP = 3;

/** Email changes a person may ask for in 24 hours (E2-13). */
export const EMAIL_CHANGE_DAILY_CAP = 5;
/** Reset requests per client address and hour beyond which nothing more is done (the answer stays the same). */
export const RESET_REQUESTS_PER_ADDRESS = 30;
/** Failed look-ups of secure links per client address in 10 minutes (ADR-04: "a small limit"). */
export const LINK_FAILURES_PER_ADDRESS = 20;

/** A password that breaks the rules: 400 with each broken rule named (FR-USR-06). */
function refusePassword(field: string, problems: readonly string[]): never {
  throw new ProblemException(
    400,
    'password_refused',
    problems.map((code) => ({ path: field, code })),
  );
}

/**
 * The person's own account and the secure links that act on it (ADR-03, ADR-04;
 * FR-USR-02, FR-USR-03, FR-USR-05, FR-USR-06; ST-15, ST-17, ST-18).
 */
@Injectable()
export class AccountService {
  readonly #resetRequests = new RateLimiter(RESET_REQUESTS_PER_ADDRESS, 60 * 60 * 1000);
  readonly #linkFailures = new RateLimiter(LINK_FAILURES_PER_ADDRESS, 10 * 60 * 1000);

  constructor(
    private readonly database: TenantDatabase,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
    private readonly hasher: PasswordHasher,
    private readonly brake: BrakeService,
    private readonly sessions: SessionService,
    private readonly links: SecureLinks,
    private readonly audit: AuditRecorder,
    private readonly mail: MailQueue,
  ) {}

  /** Whose password is set: the words the rule `not_personal` looks for. Inside the organisation. */
  async passwordContext(tx: Prisma.TransactionClient, userId: string): Promise<PasswordContext> {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, displayName: true, organisation: { select: { name: true } } },
    });
    return {
      email: user.email,
      displayName: user.displayName,
      organisationName: user.organisation.name,
    };
  }

  /**
   * The password asked again (ADR-03): right, it is valid for 5 minutes in this session;
   * wrong, it counts for the brake of the account like a failed sign-in.
   */
  async confirmPassword(
    access: { sessionId: string; userId: string; organisationId: string },
    password: string,
    clientAddress: string,
  ): Promise<Date> {
    const user = await this.database.db.user.findUniqueOrThrow({
      where: { id: access.userId },
      select: { passwordHash: true },
    });
    // The session proves an earlier sign-in of this browser: like a known device, it is
    // exempt from the account's brake (which others can trigger), not from the address's.
    const attempt = {
      clientAddress,
      user: { organisationId: access.organisationId, userId: access.userId },
      knownDevice: true,
    };
    const brake = await this.brake.state(attempt);
    if (brake.accountBraked || !(await this.hasher.matches(user.passwordHash, password))) {
      await this.brake.recordFailure('password_confirmation_failed', attempt);
      throw new ProblemException(403, 'password_incorrect');
    }
    return this.database.transaction((tx) => this.sessions.confirmPassword(tx, access.sessionId));
  }

  /** The own password, changed with the current one (ADR-03). Ends every other session. */
  async changePassword(
    access: { sessionId: string; userId: string; organisationId: string },
    current: string,
    next: string,
    repeat: string,
    clientAddress: string,
  ): Promise<void> {
    await this.confirmPassword(access, current, clientAddress);
    await this.database.transaction(async (tx) => {
      const problems = passwordProblems(
        next,
        repeat,
        await this.passwordContext(tx, access.userId),
      );
      if (problems.length > 0) {
        refusePassword('newPassword', problems);
      }
      await tx.user.update({
        where: { id: access.userId },
        data: {
          passwordHash: await this.hasher.hash(next),
          passwordChangedAt: new Date(),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      await this.sessions.endAllOf(tx, access.userId, 'password_changed', access.sessionId);
      // Every open link of the account, an email change asked for under the old password
      // included (E2-03).
      await this.links.revokeAll(tx, access.userId);
      await this.audit.record(tx, {
        organisationId: access.organisationId,
        actorUserId: access.userId,
        action: 'account.password_changed',
        subjectType: 'user',
        subjectId: access.userId,
      });
      await this.mail.noticeToAdmins(tx, access.organisationId, 'own_password_changed', {
        subjectUserId: access.userId,
      });
    });
  }

  /**
   * An email change (ADR-03, ST-18): needs the current password, is confirmed through a
   * link sent to the new address, and announced to the old one; it ends the sessions when
   * it is confirmed.
   */
  async requestEmailChange(
    access: { sessionId: string; userId: string; organisationId: string },
    password: string,
    newEmail: string,
    clientAddress: string,
  ): Promise<void> {
    await this.confirmPassword(access, password, clientAddress);
    if ((await this.resolvers.userByEmail(newEmail)) !== null) {
      // An email is unique across the instance (ADR-06; the disclosure is noted there).
      throw new ProblemException(409, 'email_taken');
    }
    await this.database.transaction(async (tx) => {
      // At most a few a day: the confirmation goes to an address the person types (E2-13).
      const today = await this.mail.countSince(
        tx,
        access.userId,
        'email_change_confirmation',
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );
      if (today >= EMAIL_CHANGE_DAILY_CAP) {
        throw new ProblemException(429, 'too_many_requests');
      }
      const user = await tx.user.findUniqueOrThrow({
        where: { id: access.userId },
        select: { email: true },
      });
      const request = `${access.userId}:${Date.now().toString(36)}`;
      await this.mail.enqueue(tx, {
        organisationId: access.organisationId,
        kind: 'email_change_confirmation',
        recipientUserId: access.userId,
        recipientAddress: newEmail,
        linkPurpose: 'email_change',
        linkUserId: access.userId,
        uniqueKey: `email_change_confirmation:${request}`,
      });
      await this.mail.enqueue(tx, {
        organisationId: access.organisationId,
        kind: 'email_change_notice',
        recipientUserId: access.userId,
        recipientAddress: user.email,
        uniqueKey: `email_change_notice:${request}`,
      });
      await this.audit.record(tx, {
        organisationId: access.organisationId,
        actorUserId: access.userId,
        action: 'account.email_change_requested',
        subjectType: 'user',
        subjectId: access.userId,
        changes: { email: { old: user.email, new: newEmail } },
      });
      await this.mail.noticeToAdmins(tx, access.organisationId, 'own_email_change_requested', {
        subjectUserId: access.userId,
      });
    });
  }

  /**
   * A request for a password reset (ADR-04, ST-15, ST-16). The caller answers the same
   * whatever happens here. Nothing is done for an unknown, invited, deactivated or removed
   * account; nothing within the cool-down of the last reset message (so the first link stays
   * valid), and nothing beyond the daily cap.
   */
  async requestReset(email: string, clientAddress: string): Promise<void> {
    if (!this.#resetRequests.take(clientAddress)) {
      return;
    }
    const resolved = await this.resolvers.userByEmail(email.trim());
    if (resolved === null) {
      return;
    }
    await this.context.run(resolved.organisationId, () =>
      this.database.transaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: resolved.userId },
          select: { status: true, email: true },
        });
        if (user?.status !== 'active') {
          return;
        }
        const now = Date.now();
        const recent = await this.mail.countSince(
          tx,
          resolved.userId,
          'password_reset',
          new Date(now - RESET_COOL_DOWN_MS),
        );
        const today = await this.mail.countSince(
          tx,
          resolved.userId,
          'password_reset',
          new Date(now - 24 * 60 * 60 * 1000),
        );
        if (recent > 0 || today >= RESET_DAILY_CAP) {
          return;
        }
        await this.mail.enqueue(tx, {
          organisationId: resolved.organisationId,
          kind: 'password_reset',
          recipientUserId: resolved.userId,
          recipientAddress: user.email,
          linkPurpose: 'password_reset',
          linkUserId: resolved.userId,
          uniqueKey: `password_reset:${resolved.userId}:${now.toString(36)}`,
        });
        await this.audit.record(tx, {
          organisationId: resolved.organisationId,
          actorUserId: null,
          action: 'password_reset.requested',
          subjectType: 'user',
          subjectId: resolved.userId,
        });
      }),
    );
  }

  /**
   * The open link of a token for a purpose, or a 404 that says nothing about why. Too many
   * failed look-ups from one address: 429.
   */
  async openLink(token: string, purpose: LinkPurpose, clientAddress: string): Promise<OpenLink> {
    if (this.#linkFailures.isOver(clientAddress)) {
      throw new ProblemException(429, 'too_many_requests');
    }
    const link = await this.links.open(token, purpose);
    if (link === null) {
      this.#linkFailures.take(clientAddress);
      throw new ProblemException(404, 'link_invalid');
    }
    return link;
  }

  /** What the page of an invitation or reset link shows. */
  async linkPerson(link: OpenLink): Promise<PasswordContext & { expiresAt: Date }> {
    return this.context.run(link.organisationId, () =>
      this.database.transaction(async (tx) => ({
        ...(await this.passwordContext(tx, link.userId)),
        expiresAt: link.expiresAt,
      })),
    );
  }

  /**
   * Sets a password through an invitation or a reset link (FR-USR-02, FR-USR-03): uses the
   * link up, sets the password, makes an invited user active. A reset ends every session
   * of the user (ADR-03) and revokes the user's other reset links.
   */
  async setPasswordByLink(link: OpenLink, password: string, repeat: string): Promise<void> {
    await this.context.run(link.organisationId, () =>
      this.database.transaction(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { id: link.userId },
          select: { status: true },
        });
        const allowed =
          link.purpose === 'invitation' ? user.status === 'invited' : user.status === 'active';
        if (!allowed) {
          throw new ProblemException(404, 'link_invalid');
        }
        const problems = passwordProblems(
          password,
          repeat,
          await this.passwordContext(tx, link.userId),
        );
        if (problems.length > 0) {
          refusePassword('password', problems);
        }
        if (!(await this.links.consume(tx, link))) {
          throw new ProblemException(404, 'link_invalid');
        }
        await tx.user.update({
          where: { id: link.userId },
          data: {
            passwordHash: await this.hasher.hash(password),
            passwordChangedAt: new Date(),
            status: 'active',
            version: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        if (link.purpose === 'password_reset') {
          await this.sessions.endAllOf(tx, link.userId, 'password_reset');
          await this.links.revokeAll(tx, link.userId);
          await this.mail.noticeToAdmins(tx, link.organisationId, 'password_reset', {
            subjectUserId: link.userId,
          });
        } else {
          await this.links.revokeAll(tx, link.userId, ['invitation']);
        }
        await this.audit.record(tx, {
          organisationId: link.organisationId,
          actorUserId: link.userId,
          action:
            link.purpose === 'invitation' ? 'invitation.accepted' : 'password_reset.completed',
          subjectType: 'user',
          subjectId: link.userId,
        });
      }),
    );
  }

  /** Confirms an email change from the new address (ADR-03, ST-18): ends every session. */
  async confirmEmailChange(link: OpenLink): Promise<void> {
    if ((await this.resolvers.userByEmail(link.recipient)) !== null) {
      throw new ProblemException(409, 'email_taken');
    }
    try {
      await this.moveToAddress(link);
    } catch (error) {
      // Another account took the address between the check above and this change (E2-15).
      if ((error as { code?: unknown }).code === 'P2002') {
        throw new ProblemException(409, 'email_taken');
      }
      throw error;
    }
  }

  private async moveToAddress(link: OpenLink): Promise<void> {
    await this.context.run(link.organisationId, () =>
      this.database.transaction(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { id: link.userId },
          select: { status: true, email: true },
        });
        if (user.status !== 'active' || !(await this.links.consume(tx, link))) {
          throw new ProblemException(404, 'link_invalid');
        }
        await tx.user.update({
          where: { id: link.userId },
          data: { email: link.recipient, version: { increment: 1 }, updatedAt: new Date() },
        });
        await this.sessions.endAllOf(tx, link.userId, 'email_changed');
        await this.links.revokeAll(tx, link.userId);
        await this.audit.record(tx, {
          organisationId: link.organisationId,
          actorUserId: link.userId,
          action: 'account.email_changed',
          subjectType: 'user',
          subjectId: link.userId,
          changes: { email: { old: user.email, new: link.recipient } },
        });
      }),
    );
  }
}
