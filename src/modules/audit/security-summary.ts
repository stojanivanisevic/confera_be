import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../common/logging/app-logger';
import { SystemResolvers } from '../../platform/prisma/system/resolvers';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { AuditRecorder } from './audit-recorder';

/** Security events are kept this long (ADR-29: 90 days). */
export const SECURITY_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The summary of failed sign-ins for unknown addresses (ADR-06, SA-18, ST-24): such
 * failures belong to no organisation, so they are counted in the instance table of
 * security events and appear in the audit log of every organisation as ONE summed entry
 * per run. The run also removes the events older than their retention period.
 *
 * Started by the operator's command or the scheduler of part B; `run()` is the whole job.
 */
@Injectable()
export class SecuritySummary {
  constructor(
    private readonly database: TenantDatabase,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
    private readonly audit: AuditRecorder,
    private readonly logger: AppLogger,
  ) {}

  /** @returns how many failed sign-ins for unknown addresses the run summed up. */
  async run(now = new Date()): Promise<number> {
    const { count, from, to } = await this.database.instance(async (tx) => {
      const unknown = await tx.securityEvent.findMany({
        where: { kind: 'sign_in_failed', userId: null, summarisedAt: null },
        select: { id: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      });
      if (unknown.length > 0) {
        await tx.securityEvent.updateMany({
          where: { id: { in: unknown.map(({ id }) => id) } },
          data: { summarisedAt: now },
        });
      }
      await tx.securityEvent.deleteMany({
        where: { occurredAt: { lt: new Date(now.getTime() - SECURITY_EVENT_RETENTION_MS) } },
      });
      return {
        count: unknown.length,
        from: unknown[0]?.occurredAt ?? now,
        to: unknown[unknown.length - 1]?.occurredAt ?? now,
      };
    });
    if (count === 0) {
      return 0;
    }
    // A job across organisations loops over them, one after another (ADR-05).
    for (const organisationId of await this.resolvers.organisationsWithUsers()) {
      await this.context.run(organisationId, () =>
        this.database.transaction((tx) =>
          this.audit.record(tx, {
            organisationId,
            actorUserId: null,
            action: 'security.unknown_address_sign_ins',
            subjectType: 'instance',
            detail: { count, from: from.toISOString(), to: to.toISOString() },
          }),
        ),
      );
    }
    this.logger.info('security.summary', { count });
    return count;
  }
}
