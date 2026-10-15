import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AppLogger } from '../../common/logging/app-logger';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import { SystemResolvers } from '../../platform/prisma/system/resolvers';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { MailSender } from './mail-sender';

/** A row left in `sending` this long was interrupted (a crash) and is flagged `stuck`. */
export const STUCK_AFTER_MS = 10 * 60_000;

/** Rows a tick looks at, at most. */
const BATCH = 50;

export interface TickReport {
  sent: number;
  queued: number;
  waiting: number;
  failed: number;
  stuck: number;
}

/**
 * The outbox worker (ADR-13, ADR-18): every MAIL_WORKER_INTERVAL_SECONDS it asks the
 * resolver which rows are due, and for each, inside its organisation, claims the row
 * (queued to sending, one statement, so two workers never send one message twice) and
 * hands it to the sender. A row left in `sending` by a crash is flagged `stuck` and not
 * sent again by itself: delivery after an ambiguous failure is at most once.
 *
 * Without a mail server the worker finds nothing to send it through, the row waits, and
 * the application stays healthy (ST-27). The log holds counts and codes, never an
 * address, a subject or a body.
 */
@Injectable()
export class MailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<TickReport> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
    private readonly database: TenantDatabase,
    private readonly sender: MailSender,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.mail.workerIntervalSeconds;
    if (seconds === 0) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.warn('mail.worker_failed', {
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

  /** One look at the outbox. A tick that starts while another runs waits for that one. */
  tick(now = new Date()): Promise<TickReport> {
    if (this.#running !== undefined) {
      return this.#running;
    }
    this.#running = this.work(now).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  private async work(now: Date): Promise<TickReport> {
    const report: TickReport = { sent: 0, queued: 0, waiting: 0, failed: 0, stuck: 0 };
    const { due, stale } = await this.resolvers.outboxDue(
      now,
      new Date(now.getTime() - STUCK_AFTER_MS),
      BATCH,
    );
    for (const row of stale) {
      await this.context.run(row.organisationId, async () => {
        const flagged = await this.database.db.mailMessage.updateMany({
          where: { id: row.messageId, status: 'sending' },
          data: { status: 'stuck', lastErrorCode: 'interrupted' },
        });
        report.stuck += flagged.count;
      });
    }
    for (const row of due) {
      await this.context.run(row.organisationId, async () => {
        const claimed = await this.database.db.mailMessage.updateMany({
          where: { id: row.messageId, status: 'queued', nextAttemptAt: { lte: now } },
          data: { status: 'sending', claimedAt: new Date() },
        });
        if (claimed.count !== 1) {
          return;
        }
        try {
          const outcome = await this.sender.send(row.messageId, now);
          report[outcome.status === 'waiting' ? 'waiting' : outcome.status] += 1;
        } catch (error) {
          // A template that no longer renders (a row planted past the checks): the message
          // fails with a code, the worker goes on with the next one.
          await this.database.db.mailMessage.update({
            where: { id: row.messageId },
            data: { status: 'failed', lastErrorCode: 'render_failed', claimedAt: null },
          });
          report.failed += 1;
          this.logger.warn('mail.render_failed', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      });
    }
    if (report.sent + report.failed + report.stuck + report.queued > 0) {
      this.logger.info('mail.worker_tick', { ...report });
    }
    return report;
  }
}
