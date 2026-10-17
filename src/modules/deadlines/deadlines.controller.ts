import {
  Body,
  Get,
  HttpStatus,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import { AuditRecorder } from '../audit/audit-recorder';
import { deadlineEnd, deadlinePassed } from './deadline-time';
import { DEADLINE_KINDS, type DeadlineKind, DeadlinesDto, SetDeadlineDto } from './deadlines.dto';

/**
 * The deadlines of a conference (M3-BE-05; FR-DL-01 to 03): abstract submission, fee
 * payment, full paper. A deadline is a day; it ends at the end of that day in the
 * conference's time zone. An admin sets and extends it; the form opens again at once; the
 * history keeps every old and new day and who changed it, and the audit log the change.
 */
const day = (value: Date): string => value.toISOString().slice(0, 10);

@Injectable()
export class DeadlinesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: AuditRecorder,
  ) {}

  list(conferenceId: string): Promise<DeadlinesDto> {
    return this.database.transaction((tx) => this.dto(tx, conferenceId));
  }

  set(
    actor: Access,
    conferenceId: string,
    kind: string,
    input: SetDeadlineDto,
  ): Promise<DeadlinesDto> {
    if (!(DEADLINE_KINDS as readonly string[]).includes(kind)) {
      throw new ProblemException(404, 'not_found');
    }
    return this.database.transaction(async (tx) => {
      const conference = await this.conference(tx, conferenceId);
      if (conference.state === 'archived') {
        throw new ProblemException(409, 'conference_archived');
      }
      const endsOn = new Date(`${input.endsOn}T00:00:00Z`);
      const before = await tx.conferenceDeadline.findFirst({ where: { conferenceId, kind } });
      if (before === null) {
        await tx.conferenceDeadline.create({
          data: { organisationId: actor.organisationId, conferenceId, kind, endsOn },
        });
      } else {
        if (input.version === undefined) {
          throw new ProblemException(409, 'version_conflict');
        }
        const changed = await tx.conferenceDeadline.updateMany({
          where: { id: before.id, version: input.version },
          data: { endsOn, version: { increment: 1 }, updatedAt: new Date() },
        });
        if (changed.count !== 1) {
          throw new ProblemException(409, 'version_conflict');
        }
      }
      const old = before === null ? null : day(before.endsOn);
      if (old !== input.endsOn) {
        await tx.conferenceDeadlineChange.create({
          data: {
            organisationId: actor.organisationId,
            conferenceId,
            kind,
            oldEndsOn: before?.endsOn ?? null,
            newEndsOn: endsOn,
            changedBy: actor.userId,
          },
        });
        await this.audit.record(tx, {
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          action: 'conference.deadline_changed',
          subjectType: 'conference_deadline',
          subjectId: conferenceId,
          changes: { endsOn: { old, new: input.endsOn } },
        });
      }
      return this.dto(tx, conferenceId);
    });
  }

  private async conference(tx: Prisma.TransactionClient, id: string) {
    const conference = await tx.conference.findUnique({
      where: { id },
      select: { state: true, timeZone: true },
    });
    if (conference === null) {
      throw new ProblemException(404, 'not_found');
    }
    return conference;
  }

  private async dto(tx: Prisma.TransactionClient, conferenceId: string): Promise<DeadlinesDto> {
    const conference = await this.conference(tx, conferenceId);
    const rows = await tx.conferenceDeadline.findMany({ where: { conferenceId } });
    const history = await tx.conferenceDeadlineChange.findMany({
      where: { conferenceId },
      include: { changer: { select: { id: true, displayName: true } } },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    const now = new Date();
    return {
      timeZone: conference.timeZone,
      items: DEADLINE_KINDS.flatMap((kind) => {
        const row = rows.find((candidate) => candidate.kind === kind);
        if (row === undefined) {
          return [];
        }
        const endsOn = day(row.endsOn);
        return [
          {
            kind,
            endsOn,
            endsAt: deadlineEnd(endsOn, conference.timeZone).toISOString(),
            passed: deadlinePassed(endsOn, conference.timeZone, now),
            version: row.version,
          },
        ];
      }),
      history: history.map((change) => ({
        kind: change.kind as DeadlineKind,
        oldEndsOn: change.oldEndsOn === null ? null : day(change.oldEndsOn),
        newEndsOn: day(change.newEndsOn),
        changedAt: change.changedAt.toISOString(),
        changedBy: change.changer,
      })),
    };
  }
}

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

@AdminController('conferences')
export class DeadlinesController {
  constructor(private readonly deadlines: DeadlinesService) {}

  @Get(':id/deadlines')
  @Permission('conferences.read')
  listDeadlines(@Param('id', ID) id: string): Promise<DeadlinesDto> {
    return this.deadlines.list(id);
  }

  /** Sets or extends a deadline (FR-DL-03): the form opens again at once; the history keeps both days. */
  @Put(':id/deadlines/:kind')
  @Permission('conferences.manage')
  setDeadline(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Param('kind') kind: string,
    @Body() body: SetDeadlineDto,
  ): Promise<DeadlinesDto> {
    return this.deadlines.set(access, id, kind, body);
  }
}

@Module({ controllers: [DeadlinesController], providers: [DeadlinesService] })
export class DeadlinesModule {}
