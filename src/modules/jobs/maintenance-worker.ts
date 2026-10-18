import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AppLogger } from '../../common/logging/app-logger';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import { SystemResolvers } from '../../platform/prisma/system/resolvers';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { AuditModule } from '../audit/audit.module';
import { AuditRecorder } from '../audit/audit-recorder';
import { SecuritySummary } from '../audit/security-summary';

/** The jobs of this worker run at most this often, however short the jobs interval is. */
export const MAINTENANCE_EVERY_MS = 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** The messages the retention removes once they are old: those that are done with. */
const DONE = ['sent', 'failed', 'discarded', 'stuck'];

export interface MaintenanceReport {
  /** Failed sign-ins for unknown addresses summed into the audit logs. */
  summarised: number;
  /** Mail log entries and messages removed by the retention. */
  logEntries: number;
  messages: number;
}

/**
 * The housekeeping of the instance (ADR-18), every `JOBS_INTERVAL_SECONDS` and at most once
 * an hour; tests call `run()`:
 *
 * - **the security summary** (ADR-06, SA-18, M2-ISS-12): failed sign-ins for unknown
 *   addresses as one summed entry in every organisation's audit log, and the security events
 *   older than 90 days removed;
 * - **the retention of the mail log** (FR-SMTP-06, M4-BE-05): per organisation, the entries
 *   older than its retention period, and the messages that are done with and as old, with
 *   their content. A message that waits (queued, held, waiting for a server) is never removed.
 */
@Injectable()
export class MaintenanceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<MaintenanceReport> | undefined;
  #lastRun = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
    private readonly database: TenantDatabase,
    private readonly summary: SecuritySummary,
    private readonly audit: AuditRecorder,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.jobs.intervalSeconds;
    if (seconds === 0) {
      return;
    }
    this.#timer = setInterval(() => {
      if (Date.now() - this.#lastRun < MAINTENANCE_EVERY_MS) {
        return;
      }
      void this.run().catch((error: unknown) => {
        this.logger.warn('maintenance.failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      });
    }, seconds * 1000);
    this.#timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.#timer);
    await this.#running?.catch(() => undefined);
  }

  /** One run of every job. A run that starts while another runs waits for that one. */
  run(now = new Date()): Promise<MaintenanceReport> {
    if (this.#running !== undefined) {
      return this.#running;
    }
    this.#lastRun = now.getTime();
    this.#running = this.work(now).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  private async work(now: Date): Promise<MaintenanceReport> {
    const report: MaintenanceReport = { summarised: 0, logEntries: 0, messages: 0 };
    report.summarised = await this.summary.run(now);
    for (const organisationId of await this.resolvers.organisationsWithUsers()) {
      await this.context.run(organisationId, () => this.retention(organisationId, now, report));
    }
    if (report.summarised + report.logEntries + report.messages > 0) {
      this.logger.info('maintenance.run', { ...report });
    }
    return report;
  }

  private async retention(
    organisationId: string,
    now: Date,
    report: MaintenanceReport,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const organisation = await tx.organisation.findUniqueOrThrow({
        where: { id: organisationId },
        select: { mailLogRetentionDays: true },
      });
      const before = new Date(now.getTime() - organisation.mailLogRetentionDays * DAY_MS);
      const entries = await tx.mailLogEntry.deleteMany({ where: { sentAt: { lt: before } } });
      // A message goes with its log (the foreign key cascades) once both are old.
      const messages = await tx.mailMessage.deleteMany({
        where: {
          status: { in: DONE },
          createdAt: { lt: before },
          log: { none: { sentAt: { gte: before } } },
        },
      });
      if (entries.count + messages.count > 0) {
        await this.audit.record(tx, {
          organisationId,
          actorUserId: null,
          action: 'mail_log.purged',
          subjectType: 'mail_log_retention',
          subjectId: organisationId,
          detail: { count: entries.count + messages.count, to: before.toISOString() },
        });
      }
      report.logEntries += entries.count;
      report.messages += messages.count;
    });
  }
}

@Module({
  imports: [AuditModule],
  providers: [MaintenanceWorker],
  exports: [MaintenanceWorker],
})
export class JobsModule {}
