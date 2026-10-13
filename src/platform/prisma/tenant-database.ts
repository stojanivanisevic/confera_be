import { Inject, Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { TenantContext } from '../tenancy/tenant-context';
import { type DatabaseRole, describeRole } from './database-role';
import {
  createBaseClient,
  createTenantClient,
  type QueryObserver,
  restrict,
  type TenantClient,
  tenantTransaction,
} from './tenant-client';

/**
 * Token of the observer of SQL statements. Nothing in the application provides it; the
 * dev-tools module does when DEV_LOG_QUERIES is on, and that module is not in the
 * production build. So on a server query logging is not switched off: it does not exist.
 */
export const QUERY_OBSERVER = Symbol('QUERY_OBSERVER');

/**
 * The database as application code sees it: always inside the organisation of the
 * current request or job, always as the application role, always under row-level
 * security (ADR-05).
 *
 *   await this.database.db.user.findMany()                     // one statement
 *   await this.database.transaction((tx) => ...)               // several, atomically
 *
 * Without an organisation in the context both throw NoOrganisationError before anything
 * reaches the database; and if a statement did reach it, the policies would return
 * nothing. There is no way from here to a client without row-level security.
 */
@Injectable()
export class TenantDatabase implements OnModuleDestroy {
  readonly #base: PrismaClient;

  /** Models and tagged-template raw queries, one transaction per operation. */
  readonly db: TenantClient;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly context: TenantContext,
    @Optional() @Inject(QUERY_OBSERVER) onQuery?: QueryObserver,
  ) {
    this.#base = createBaseClient(config.database.applicationUrl.reveal(), { onQuery });
    this.db = restrict(createTenantClient(this.#base, () => this.context.requireOrganisationId()));
  }

  /** Several statements in one transaction, inside the current organisation. */
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return tenantTransaction(this.#base, this.context.requireOrganisationId(), work);
  }

  /** True when the database answers. Reads no table. */
  async isReachable(): Promise<boolean> {
    try {
      await this.#base.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /** For the start-up check only: what the application role is allowed to do. */
  describeRole(): Promise<DatabaseRole> {
    return describeRole(this.#base);
  }

  async onModuleDestroy(): Promise<void> {
    await this.#base.$disconnect();
  }
}
