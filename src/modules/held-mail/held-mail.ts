import { Body, Get, HttpCode, Injectable, Module, Patch, Post, Query } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ProblemException } from '../../common/http/problem';
import { VALIDATION_FAILED } from '../../common/http/validation';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import { AuditRecorder } from '../audit/audit-recorder';

/**
 * The emails the send breaker holds (ADR-08, M3-BE-09, M3-FE-08): the list with why each
 * waits, and the release by an admin. A released email is queued as any other and goes out
 * at the send rate of its mail server. The breaker of the organisation is set here too; a
 * form's own is set on the form.
 */
export const HELD_REASONS = [
  'send_breaker_form',
  'send_breaker_organisation',
  'recipient_domain',
] as const;

export class HeldMailDto {
  id!: string;
  kind!: string;
  recipient!: string;
  @ApiProperty({ enum: HELD_REASONS })
  heldReason!: (typeof HELD_REASONS)[number];
  conference!: { id: string; code: string; name: string } | null;
  formId!: string | null;
  submission!: { id: string; reference: string } | null;
  createdAt!: string;
}

export class HeldMailPageDto {
  items!: HeldMailDto[];
  total!: number;
  page!: number;
  pageSize!: number;
  /** The send breaker of the organisation (ADR-08). */
  breaker!: { perHour: number; perDay: number; version: number };
}

export class HeldMailQueryDto {
  @IsOptional()
  @IsUUID('4')
  formId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** Releases the held emails named, or every one (of a form, when `formId` is given). */
export class ReleaseHeldMailDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  ids?: string[];

  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @IsOptional()
  @IsUUID('4')
  formId?: string;
}

export class ReleasedDto {
  released!: number;
}

export class OrganisationBreakerDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  perHour!: number;

  @IsInt()
  @Min(1)
  @Max(100_000)
  perDay!: number;

  /** The version of the organisation profile. */
  @IsInt()
  @Min(1)
  version!: number;
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
        changes: {
          breakerPerHour: { old: String(before.breakerPerHour), new: String(input.perHour) },
          breakerPerDay: { old: String(before.breakerPerDay), new: String(input.perDay) },
        },
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
