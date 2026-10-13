import { Global, Module } from '@nestjs/common';
import { TenantContext } from '../tenancy/tenant-context';
import { DatabaseRoleCheck } from './database-role-check';
import { SystemResolvers } from './system/resolvers';
import { TenantDatabase } from './tenant-database';

/**
 * Data access (ADR-05). What other modules may inject:
 *
 *   TenantContext     which organisation the current request or job works in
 *   TenantDatabase    the database inside that organisation, under row-level security
 *   SystemResolvers   the few look-ups that find an organisation before one is known
 *
 * There is nothing else to inject: no client without an organisation, and no client of
 * the system role.
 */
@Global()
@Module({
  providers: [TenantContext, TenantDatabase, SystemResolvers, DatabaseRoleCheck],
  exports: [TenantContext, TenantDatabase, SystemResolvers],
})
export class PrismaModule {}
