import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppLogger } from '../../common/logging/app-logger';
import { StartupRefusal } from '../../common/startup-refusal';
import { type DatabaseRole, type RoleKind, roleProblems } from './database-role';
import { SystemResolvers } from './system/resolvers';
import { TenantDatabase } from './tenant-database';

const VARIABLE: Readonly<Record<RoleKind, string>> = {
  application: 'DATABASE_URL',
  system: 'SYSTEM_DATABASE_URL',
};

/**
 * The start-up role check (ADR-05, finding SEC-A-12, test ST-08).
 *
 * At every start the API asks the database what its two roles may do, and refuses to
 * start when the application role is a superuser, may bypass row-level security, owns
 * anything or may change the schema; or when the system role may do more than bypass
 * the policies. A restore that recreates a role with the wrong rights is caught here,
 * before the first request.
 */
@Injectable()
export class DatabaseRoleCheck implements OnModuleInit {
  constructor(
    private readonly tenant: TenantDatabase,
    private readonly system: SystemResolvers,
    private readonly logger: AppLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    const application = await this.describe('application', () => this.tenant.describeRole());
    const system = await this.describe('system', () => this.system.describeRole());

    this.refuseOn('application', application);
    this.refuseOn('system', system);
    if (application.name === system.name) {
      throw new StartupRefusal(
        'DATABASE_URL and SYSTEM_DATABASE_URL use the same database role. The application role and the system role must be two roles (ADR-05).',
      );
    }
    this.logger.info('database.roles.checked', {
      application: application.name,
      system: system.name,
    });
  }

  private async describe(kind: RoleKind, read: () => Promise<DatabaseRole>): Promise<DatabaseRole> {
    try {
      return await read();
    } catch (error) {
      // The driver's message can name the address; the log keeps it (redacted), the
      // terminal gets the fixed sentence.
      this.logger.error('database.unreachable', error instanceof Error ? error : {}, {
        role: kind,
      });
      throw new StartupRefusal(
        `The database cannot be reached with ${VARIABLE[kind]} (the ${kind} role). Is PostgreSQL running, and were "db:provision" and "db:migrate" run?`,
      );
    }
  }

  private refuseOn(kind: RoleKind, role: DatabaseRole): void {
    const problems = roleProblems(kind, role);
    if (problems.length > 0) {
      throw new StartupRefusal(
        `The ${kind} database role of ${VARIABLE[kind]} ${problems.join('; ')}. The API refuses to start, because row-level security or the expiry times would not hold (ADR-05).`,
      );
    }
  }
}
