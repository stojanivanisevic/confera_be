import type { PrismaClient } from '../../../generated/prisma/client';
import { createBaseClient } from '../tenant-client';

/**
 * The system client: a connection as confera_system, the role that may bypass row-level
 * security (ADR-05).
 *
 * THIS FILE IS IMPORTED BY resolvers.ts AND BY NOTHING ELSE. An architecture test fails
 * on any other import (ST-09). A new need for the system role is a new resolver in
 * resolvers.ts, which returns ids and nothing else.
 */
export function createSystemClient(connectionString: string): PrismaClient {
  // Resolvers run one short look-up per request; a small pool is enough.
  return createBaseClient(connectionString, { poolSize: 3 });
}
