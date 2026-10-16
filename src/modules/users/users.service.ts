import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { ProblemException } from '../../common/http/problem';
import { isUniqueViolation } from '../../platform/prisma/errors';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import type { RoleName } from '../access/permissions';
import { type EndReason, SessionService } from '../access/session.service';
import { AuditRecorder } from '../audit/audit-recorder';
import { SecureLinks } from '../links/secure-links';
import { MailQueue, type SecurityChange } from '../mail/mail-queue';
import type { InvitationDelivery, UserDto, UserPageDto, UserQueryDto } from './users.dto';

const DEFAULT_PAGE_SIZE = 25;

/** A resent invitation within this time is queued once (double submit, ADR-13 unique key). */
const RESEND_WINDOW_MS = 60 * 1000;

const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  createdAt: true,
  version: true,
  roles: { select: { role: true } },
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function toDto(user: UserRow, invitationDelivery: InvitationDelivery | null = null): UserDto {
  const roles = user.roles.map(({ role }) => role);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: roles.includes('admin') ? 'admin' : (roles[0] ?? 'reviewer'),
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    version: user.version,
    invitationDelivery: user.status === 'invited' ? invitationDelivery : null,
  };
}

/** What the admin is told of an invitation's message, from the state of its outbox row. */
function deliveryOf(status: string): InvitationDelivery {
  switch (status) {
    case 'queued':
    case 'sending':
      return 'queued';
    case 'waiting_for_server':
      return 'waiting_for_server';
    case 'sent':
      return 'sent';
    default:
      return 'failed';
  }
}

/** `%`, `_` and `\` of a search are text, not patterns (ADR-05: "search input is escaped"). */
export function likePattern(search: string): string {
  return search.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * User administration (FR-USR-01, FR-USR-02, FR-USR-04; ST-19). Everything runs inside the
 * organisation of the signed-in admin, under row-level security: a user of another
 * organisation is not found.
 *
 * - Every change of a user or a role needs the password asked again (the routes say
 *   `@FreshPassword`) and tells every active admin.
 * - The last active admin cannot be demoted, deactivated or removed (FR-USR-04).
 * - A change of role, a deactivation and a removal end every session of that user.
 * - A removed user stays, so that past actions stay attributed: state `removed`, no
 *   password, and the address freed for a new account.
 * - Two admins changing the same user: the change names the version it was made on, and
 *   the second one is refused (409 `version_conflict`).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly sessions: SessionService,
    private readonly links: SecureLinks,
    private readonly audit: AuditRecorder,
    private readonly mail: MailQueue,
  ) {}

  async list(query: UserQueryDto): Promise<UserPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const search = query.search?.trim();
    const where: Prisma.UserWhereInput = {
      status: query.status ?? { not: 'removed' },
      ...(query.role === undefined ? {} : { roles: { some: { role: query.role } } }),
      ...(search === undefined || search === ''
        ? {}
        : {
            OR: [
              { displayName: { contains: likePattern(search), mode: 'insensitive' } },
              { email: { contains: likePattern(search), mode: 'insensitive' } },
            ],
          }),
    };
    const [total, users] = await this.database.transaction((tx) =>
      Promise.all([
        tx.user.count({ where }),
        tx.user.findMany({
          where,
          select: USER_SELECT,
          orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]),
    );
    const deliveries = await this.database.transaction((tx) => this.deliveries(tx, users));
    return {
      items: users.map((user) => toDto(user, deliveries.get(user.id) ?? null)),
      total,
      page,
      pageSize,
    };
  }

  async get(id: string): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, select: USER_SELECT });
      if (user === null) {
        throw new ProblemException(404, 'not_found');
      }
      return this.dto(tx, user);
    });
  }

  /** Invites a user (FR-USR-02): an account without a password, and an invitation in the outbox. */
  async invite(
    actor: Access,
    input: { email: string; displayName: string; role: RoleName },
  ): Promise<UserDto> {
    try {
      return await this.database.transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            organisationId: actor.organisationId,
            email: input.email,
            displayName: input.displayName,
            status: 'invited',
          },
          select: { id: true },
        });
        // The role row carries the organisation (ADR-06), which a nested create cannot name.
        await tx.userRole.create({
          data: { organisationId: actor.organisationId, userId: created.id, role: input.role },
        });
        const user = await this.load(tx, created.id);
        await this.queueInvitation(tx, actor, user, `created:${user.id}`);
        await this.audit.record(tx, {
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          action: 'user.invited',
          subjectType: 'user',
          subjectId: user.id,
          changes: {
            email: { old: null, new: input.email },
            displayName: { old: null, new: input.displayName },
            role: { old: null, new: input.role },
          },
        });
        await this.notice(tx, actor, 'user_invited', user.id);
        return this.dto(tx, user);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProblemException(409, 'email_taken');
      }
      throw error;
    }
  }

  /** Sends the invitation again: a new link, which ends the earlier one (ADR-04). */
  async resendInvitation(actor: Access, id: string): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      const user = await this.load(tx, id);
      if (user.status !== 'invited') {
        throw new ProblemException(409, 'not_invited');
      }
      const window = Math.floor(Date.now() / RESEND_WINDOW_MS).toString(36);
      await this.queueInvitation(tx, actor, user, `resent:${user.id}:${window}`);
      return this.dto(tx, user);
    });
  }

  async update(actor: Access, id: string, displayName: string, version: number): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.loadPresent(tx, id);
      const user = await this.write(tx, before, version, { displayName });
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'user.updated',
        subjectType: 'user',
        subjectId: id,
        changes: { displayName: { old: before.displayName, new: displayName } },
      });
      await this.notice(tx, actor, 'user_changed', id);
      return this.dto(tx, user);
    });
  }

  async changeRole(actor: Access, id: string, role: RoleName, version: number): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.loadPresent(tx, id);
      const previous = toDto(before).role;
      if (previous === 'admin' && role !== 'admin') {
        await this.keepAnAdmin(tx, actor.organisationId, before);
      }
      await this.write(tx, before, version, {});
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.create({
        data: { organisationId: actor.organisationId, userId: id, role },
      });
      const user = await this.load(tx, id);
      await this.endSessions(tx, id, 'role_changed');
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'user.role_changed',
        subjectType: 'user',
        subjectId: id,
        changes: { role: { old: previous, new: role } },
      });
      await this.notice(tx, actor, 'user_role_changed', id);
      return this.dto(tx, user);
    });
  }

  async deactivate(actor: Access, id: string, version: number): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.load(tx, id);
      if (before.status === 'removed') {
        throw new ProblemException(404, 'not_found');
      }
      await this.keepAnAdmin(tx, actor.organisationId, before);
      const user = await this.write(tx, before, version, { status: 'deactivated' });
      await this.endSessions(tx, id, 'deactivated');
      await this.links.revokeAll(tx, id);
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'user.deactivated',
        subjectType: 'user',
        subjectId: id,
        changes: { status: { old: before.status, new: 'deactivated' } },
      });
      await this.notice(tx, actor, 'user_deactivated', id);
      return this.dto(tx, user);
    });
  }

  /** Reactivates a deactivated user: active again, or invited when no password was ever set. */
  async reactivate(actor: Access, id: string, version: number): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.load(tx, id);
      if (before.status !== 'deactivated') {
        throw new ProblemException(409, 'not_deactivated');
      }
      const { passwordHash } = await tx.user.findUniqueOrThrow({
        where: { id },
        select: { passwordHash: true },
      });
      const status = passwordHash === null ? 'invited' : 'active';
      const user = await this.write(tx, before, version, { status });
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'user.reactivated',
        subjectType: 'user',
        subjectId: id,
        changes: { status: { old: before.status, new: status } },
      });
      await this.notice(tx, actor, 'user_reactivated', id);
      return this.dto(tx, user);
    });
  }

  /**
   * Removes a user (FR-USR-04): the row stays for the attribution of past actions, with
   * state `removed`, no password, and an address of the reserved domain `.invalid`, so that
   * the real one is free again.
   */
  async remove(actor: Access, id: string, version: number): Promise<void> {
    await this.database.transaction(async (tx) => {
      const before = await this.load(tx, id);
      if (before.status === 'removed') {
        throw new ProblemException(404, 'not_found');
      }
      await this.keepAnAdmin(tx, actor.organisationId, before);
      await this.write(tx, before, version, {
        status: 'removed',
        email: `removed-${id}@removed.invalid`,
        passwordHash: null,
        knownDevices: { deleteMany: {} },
      });
      await this.endSessions(tx, id, 'removed');
      await this.links.revokeAll(tx, id);
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'user.removed',
        subjectType: 'user',
        subjectId: id,
        changes: { status: { old: before.status, new: 'removed' } },
      });
      await this.notice(tx, actor, 'user_removed', id);
    });
  }

  /** An admin's "end this user's sessions" (ADR-03). */
  async endUserSessions(actor: Access, id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.loadPresent(tx, id);
      await this.endSessions(tx, id, 'ended_by_admin');
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'user.sessions_ended',
        subjectType: 'user',
        subjectId: id,
      });
      await this.notice(tx, actor, 'user_sessions_ended', id);
    });
  }

  /** A user who is still there: a removed one is a name on past actions only (409). */
  private async loadPresent(tx: Prisma.TransactionClient, id: string): Promise<UserRow> {
    const user = await this.load(tx, id);
    if (user.status === 'removed') {
      throw new ProblemException(409, 'user_removed');
    }
    return user;
  }

  /**
   * The state of the latest invitation message of each invited user among `users`
   * (UXUI-M2-01): queued, waiting_for_server, sent or failed; null when there is none.
   */
  private async deliveries(
    tx: Prisma.TransactionClient,
    users: readonly UserRow[],
  ): Promise<Map<string, InvitationDelivery>> {
    const invited = users.filter((user) => user.status === 'invited').map((user) => user.id);
    const found = new Map<string, InvitationDelivery>();
    if (invited.length === 0) {
      return found;
    }
    const messages = await tx.mailMessage.findMany({
      where: { kind: 'invitation', recipientUserId: { in: invited } },
      select: { recipientUserId: true, status: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    for (const message of messages) {
      if (message.recipientUserId !== null && !found.has(message.recipientUserId)) {
        found.set(message.recipientUserId, deliveryOf(message.status));
      }
    }
    return found;
  }

  private async dto(tx: Prisma.TransactionClient, user: UserRow): Promise<UserDto> {
    return toDto(user, (await this.deliveries(tx, [user])).get(user.id) ?? null);
  }

  private async load(tx: Prisma.TransactionClient, id: string): Promise<UserRow> {
    const user = await tx.user.findUnique({ where: { id }, select: USER_SELECT });
    if (user === null) {
      throw new ProblemException(404, 'not_found');
    }
    return user;
  }

  /** Writes a change made on `version`; refuses it when the user has changed since (409). */
  private async write(
    tx: Prisma.TransactionClient,
    before: UserRow,
    version: number,
    data: Prisma.UserUpdateInput,
  ): Promise<UserRow> {
    if (before.version !== version) {
      throw new ProblemException(409, 'version_conflict');
    }
    const changed = await tx.user.updateMany({
      where: { id: before.id, version },
      data: { version: { increment: 1 }, updatedAt: new Date() },
    });
    if (changed.count !== 1) {
      throw new ProblemException(409, 'version_conflict');
    }
    return tx.user.update({ where: { id: before.id }, data, select: USER_SELECT });
  }

  /**
   * The last active admin stays (FR-USR-04). Two admins who demote each other at the same
   * moment are taken one after the other: the lock is per organisation and transaction.
   */
  private async keepAnAdmin(
    tx: Prisma.TransactionClient,
    organisationId: string,
    user: UserRow,
  ): Promise<void> {
    if (user.status !== 'active' || toDto(user).role !== 'admin') {
      return;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`confera admins ${organisationId}`}, 0))`;
    const others = await tx.user.count({
      where: { id: { not: user.id }, status: 'active', roles: { some: { role: 'admin' } } },
    });
    if (others === 0) {
      throw new ProblemException(409, 'last_admin');
    }
  }

  private async endSessions(tx: Prisma.TransactionClient, id: string, reason: EndReason) {
    await this.sessions.endAllOf(tx, id, reason);
  }

  private async queueInvitation(
    tx: Prisma.TransactionClient,
    actor: Access,
    user: UserRow,
    key: string,
  ): Promise<void> {
    await this.mail.enqueue(tx, {
      organisationId: actor.organisationId,
      kind: 'invitation',
      recipientUserId: user.id,
      recipientAddress: user.email,
      linkPurpose: 'invitation',
      linkUserId: user.id,
      parameters: { invitedBy: actor.userId },
      uniqueKey: `invitation:${key}`,
    });
    await this.audit.record(tx, {
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      action: 'invitation.queued',
      subjectType: 'user',
      subjectId: user.id,
    });
  }

  private notice(
    tx: Prisma.TransactionClient,
    actor: Access,
    change: SecurityChange,
    subjectUserId: string,
  ): Promise<number> {
    return this.mail.noticeToAdmins(tx, actor.organisationId, change, {
      actorUserId: actor.userId,
      subjectUserId,
    });
  }
}
