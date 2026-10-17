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
import { MailQueue } from '../mail/mail-queue';
import { FileStorage } from './storage';
import { VIRUS_SCANNER, type VirusScanner } from './virus-scanner';

/** Files a run looks at per organisation, at most. */
const BATCH = 20;

/** The wait before the next scan of a file whose scan could not run: 1, 2, 4 ... minutes, at most an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

export interface FilesTickReport {
  scanned: number;
  clean: number;
  infected: number;
  notClean: number;
  pending: number;
  purged: number;
}

/**
 * The background work of the files (ADR-10, ADR-18; M3-BE-04, M3-BE-08; ST-33, ST-38):
 *
 * - **Scans** every file that has been attached to a submission and waits for its scan
 *   (`pending`). Fail closed: when ClamAV does not answer, the file stays pending with its
 *   attempts counted, is tried again later, and the admins are told (once an hour); a
 *   submission is never blocked by a pending scan.
 * - **Purges** the files that were uploaded and never attached once their form token has
 *   expired, file and row, and then the expired tokens themselves.
 *
 * Every `JOBS_INTERVAL_SECONDS`, organisation by organisation; tests call `tick()`.
 */
@Injectable()
export class FilesWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<FilesTickReport> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
    private readonly database: TenantDatabase,
    private readonly storage: FileStorage,
    private readonly mail: MailQueue,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.jobs.intervalSeconds;
    if (seconds === 0) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.warn('files.worker_failed', {
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

  tick(now = new Date()): Promise<FilesTickReport> {
    if (this.#running !== undefined) {
      return this.#running;
    }
    this.#running = this.work(now).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  private async work(now: Date): Promise<FilesTickReport> {
    const report: FilesTickReport = {
      scanned: 0,
      clean: 0,
      infected: 0,
      notClean: 0,
      pending: 0,
      purged: 0,
    };
    for (const organisationId of await this.resolvers.organisationsWithUsers()) {
      await this.context.run(organisationId, async () => {
        await this.purge(now, report);
        await this.scan(organisationId, now, report);
      });
    }
    if (report.scanned + report.purged > 0) {
      this.logger.info('files.worker_tick', { ...report });
    }
    return report;
  }

  private async purge(now: Date, report: FilesTickReport): Promise<void> {
    const expired = await this.database.db.formToken.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true },
      take: 500,
    });
    if (expired.length === 0) {
      return;
    }
    const tokenIds = expired.map((token) => token.id);
    const orphans = await this.database.db.storedFile.findMany({
      where: { formTokenId: { in: tokenIds }, submissionId: null },
      select: { id: true, storageKey: true },
    });
    for (const orphan of orphans) {
      await this.storage.remove(orphan.storageKey);
      await this.database.db.storedFile.deleteMany({
        where: { id: orphan.id, submissionId: null },
      });
      report.purged += 1;
    }
    await this.database.db.formToken.deleteMany({ where: { id: { in: tokenIds } } });
  }

  private async scan(organisationId: string, now: Date, report: FilesTickReport): Promise<void> {
    const due = await this.database.db.storedFile.findMany({
      where: { scanState: 'pending', submissionId: { not: null }, nextScanAt: { lte: now } },
      orderBy: [{ nextScanAt: 'asc' }, { id: 'asc' }],
      take: BATCH,
    });
    let unavailable = false;
    for (const file of due) {
      report.scanned += 1;
      const verdict = await this.scanner.scan(this.storage.read(file.storageKey));
      switch (verdict.verdict) {
        case 'clean':
        case 'infected':
        case 'limits_exceeded': {
          const state =
            verdict.verdict === 'clean'
              ? 'clean'
              : verdict.verdict === 'infected'
                ? 'infected'
                : 'not_clean';
          await this.database.db.storedFile.updateMany({
            where: { id: file.id, scanState: 'pending' },
            data: {
              scanState: state,
              scanDetail: verdict.verdict === 'clean' ? null : verdict.verdict,
              scannedAt: new Date(),
              scanAttempts: { increment: 1 },
            },
          });
          if (verdict.verdict === 'infected') {
            // The signature's name is for the log of the scan only: an author never sees it.
            this.logger.warn('files.infected', { fileId: file.id, signature: verdict.signature });
          }
          report[state === 'clean' ? 'clean' : state === 'infected' ? 'infected' : 'notClean'] += 1;
          break;
        }
        case 'unavailable':
          unavailable = true;
          report.pending += 1;
          await this.database.db.storedFile.update({
            where: { id: file.id },
            data: {
              scanAttempts: { increment: 1 },
              scanDetail: verdict.reason,
              nextScanAt: new Date(now.getTime() + retryDelayMs(file.scanAttempts + 1)),
            },
          });
          break;
      }
    }
    if (unavailable) {
      await this.database.transaction((tx) =>
        this.mail.noticeToAdmins(
          tx,
          organisationId,
          'virus_scan_pending',
          {},
          `virus_scan_pending:${now.toISOString().slice(0, 13)}`,
        ),
      );
    }
  }
}
