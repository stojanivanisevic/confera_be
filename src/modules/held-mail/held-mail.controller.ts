import { Body, Get, HttpCode, Injectable, Module, Patch, Post, Query } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { VALIDATION_FAILED } from '../../common/http/validation';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import { AuditRecorder } from '../audit/audit-recorder';
import {
  DiscardedDto,
  DiscardHeldMailDto,
  HELD_REASONS,
  HeldMailPageDto,
  HeldMailQueryDto,
  ReleaseHeldMailDto,
  ReleasedDto,
  OrganisationBreakerDto,
} from './held-mail.dto';
import { heldNumbersOf } from './send-breaker';

/**
 * The emails the send breaker holds (ADR-08, M3-BE-09, M3-FE-08): the list with why each
 * waits, and the release by an admin. A released email is queued as any other and goes out
 * at the send rate of its mail server. The breaker of the organisation is set here too; a
 * form's own is set on the form.
 */
/** The fields whose number changed, with old and new value as text (the audit log's form). */
export function changedOf(
  pairs: Readonly<Record<string, readonly [number, number]>>,
): Record<string, { old: string; new: string }> {
  const changes: Record<string, { old: string; new: string }> = {};
  for (const [field, [old, next]] of Object.entries(pairs)) {
    if (old !== next) {
      changes[field] = { old: String(old), new: String(next) };
    }
  }
  return changes;
}

@Injectable()
export class HeldMailService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: AuditRecorder,
  ) {}

  async list(query: HeldMailQueryDto): Promise<HeldMailPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: Prisma.MailMessageWhereInput = {
      status: 'held',
      ...(query.formId === undefined ? {} : { formId: query.formId }),
    };
    return this.database.transaction(async (tx) => {
      const [total, rows, organisation] = await Promise.all([
        tx.mailMessage.count({ where }),
        tx.mailMessage.findMany({
          where,
          include: {
            conference: { select: { id: true, code: true, name: true } },
            submission: { select: { id: true, reference: true } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.organisation.findFirstOrThrow({
          select: { breakerPerHour: true, breakerPerDay: true, version: true },
        }),
      ]);
      return {
        items: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          recipient: row.recipientAddress,
          heldReason: (row.heldReason ?? 'send_breaker_form') as (typeof HELD_REASONS)[number],
          heldBy: heldNumbersOf(row),
          conference: row.conference,
          formId: row.formId,
          submission: row.submission,
          createdAt: row.createdAt.toISOString(),
        })),
        total,
        page,
        pageSize,
        breaker: {
          perHour: organisation.breakerPerHour,
          perDay: organisation.breakerPerDay,
          version: organisation.version,
        },
      };
    });
  }

  async release(actor: Access, input: ReleaseHeldMailDto): Promise<ReleasedDto> {
    if ((input.ids === undefined) === (input.all !== true)) {
      throw new ProblemException(400, VALIDATION_FAILED, [{ path: 'ids', code: 'idsOrAll' }]);
    }
    return this.database.transaction(async (tx) => {
      const now = new Date();
      const released = await tx.mailMessage.updateMany({
        where: {
          status: 'held',
          ...(input.ids === undefined ? {} : { id: { in: input.ids } }),
          ...(input.formId === undefined ? {} : { formId: input.formId }),
        },
        data: { status: 'queued', nextAttemptAt: now, releasedAt: now, releasedBy: actor.userId },
      });
      if (released.count > 0) {
        await this.audit.record(tx, {
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          action: 'held_mail.released',
          subjectType: 'held_mail',
          subjectId: input.formId ?? null,
          detail: { count: released.count },
        });
      }
      return { released: released.count };
    });
  }

  /** Discards held emails (M3-ISS-14): a state of their own, with who and when, and an audit entry. */
  async discard(actor: Access, input: DiscardHeldMailDto): Promise<DiscardedDto> {
    if ((input.ids === undefined) === (input.all !== true)) {
      throw new ProblemException(400, VALIDATION_FAILED, [{ path: 'ids', code: 'idsOrAll' }]);
    }
    return this.database.transaction(async (tx) => {
      const discarded = await tx.mailMessage.updateMany({
        where: {
          status: 'held',
          ...(input.ids === undefined ? {} : { id: { in: input.ids } }),
          ...(input.formId === undefined ? {} : { formId: input.formId }),
        },
        data: { status: 'discarded', discardedAt: new Date(), discardedBy: actor.userId },
      });
      if (discarded.count > 0) {
        await this.audit.record(tx, {
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          action: 'held_mail.discarded',
          subjectType: 'held_mail',
          subjectId: input.formId ?? null,
          detail: { count: discarded.count },
        });
      }
      return { discarded: discarded.count };
    });
  }

  async setBreaker(actor: Access, input: OrganisationBreakerDto): Promise<HeldMailPageDto> {
    await this.database.transaction(async (tx) => {
      const before = await tx.organisation.findFirstOrThrow({
        select: { id: true, breakerPerHour: true, breakerPerDay: true },
      });
      const changed = await tx.organisation.updateMany({
        where: { id: before.id, version: input.version },
        data: {
          breakerPerHour: input.perHour,
          breakerPerDay: input.perDay,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'organisation.breaker_changed',
        subjectType: 'organisation_breaker',
        subjectId: before.id,
        changes: changedOf({
          breakerPerHour: [before.breakerPerHour, input.perHour],
          breakerPerDay: [before.breakerPerDay, input.perDay],
        }),
      });
    });
    return this.list({});
  }
}

@AdminController('held-mail')
export class HeldMailController {
  constructor(private readonly held: HeldMailService) {}

  /** The held emails, oldest first, with why each waits, and the breaker of the organisation. */
  @Get()
  @Permission('held_mail.manage')
  listHeldMail(@Query() query: HeldMailQueryDto): Promise<HeldMailPageDto> {
    return this.held.list(query);
  }

  /** Releases held emails: they are queued and go out at the send rate of their server. */
  @Post('release')
  @Permission('held_mail.manage')
  @HttpCode(200)
  releaseHeldMail(
    @CurrentAccess() access: Access,
    @Body() body: ReleaseHeldMailDto,
  ): Promise<ReleasedDto> {
    return this.held.release(access, body);
  }

  /**
   * Discards held emails (M3-ISS-14): they are never sent. The web application asks for a
   * confirmation first. Only `held` emails are touched; the count says how many.
   */
  @Post('discard')
  @Permission('held_mail.manage')
  @HttpCode(200)
  discardHeldMail(
    @CurrentAccess() access: Access,
    @Body() body: DiscardHeldMailDto,
  ): Promise<DiscardedDto> {
    return this.held.discard(access, body);
  }

  /** The send breaker of the organisation (ADR-08; P: 30 an hour, 200 a day). */
  @Patch('breaker')
  @Permission('held_mail.manage')
  setOrganisationBreaker(
    @CurrentAccess() access: Access,
    @Body() body: OrganisationBreakerDto,
  ): Promise<HeldMailPageDto> {
    return this.held.setBreaker(access, body);
  }
}

@Module({ controllers: [HeldMailController], providers: [HeldMailService] })
export class HeldMailModule {}
