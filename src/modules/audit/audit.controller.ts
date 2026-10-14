import { Get, Query } from '@nestjs/common';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { Permission } from '../access/access.decorators';
import { type AuditChangeDto, AuditPageDto, AuditQueryDto } from './audit.dto';

const DEFAULT_PAGE_SIZE = 25;

/**
 * The audit log of the organisation (FR-AUD-02): an admin reads and filters it; nothing
 * changes or removes an entry through the application (there is no such route, and the
 * database refuses it to the run-time roles).
 */
@AdminController('audit')
export class AuditController {
  constructor(private readonly database: TenantDatabase) {}

  /** The entries, newest first, a page at a time. */
  @Get()
  @Permission('audit.read')
  async listAuditEntries(@Query() query: AuditQueryDto): Promise<AuditPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.AuditEntryWhereInput = {
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId }),
      ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            occurredAt: {
              ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
              ...(query.to === undefined ? {} : { lt: new Date(query.to) }),
            },
          }),
    };
    const [total, entries] = await this.database.transaction((tx) =>
      Promise.all([
        tx.auditEntry.count({ where }),
        tx.auditEntry.findMany({
          where,
          include: { actor: { select: { id: true, displayName: true } } },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]),
    );
    return {
      items: entries.map((entry) => ({
        id: entry.id,
        occurredAt: entry.occurredAt.toISOString(),
        actor: entry.actor,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        fields: entry.fields,
        changes: entry.changes as unknown as Record<string, AuditChangeDto>,
        detail: entry.detail as Record<string, string | number | boolean>,
        traceId: entry.traceId,
      })),
      total,
      page,
      pageSize,
    };
  }
}
