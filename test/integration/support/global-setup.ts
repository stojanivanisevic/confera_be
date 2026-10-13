import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareTestDatabase } from '../../support/prepare-database';

/**
 * Runs once before the integration tests (`pnpm test:int`):
 *
 * 1. reads `.env` (the addresses of the development stack);
 * 2. drops and creates a database of its own, `confera_integration_test`, with the roles
 *    of ADR-05, through the same script a developer runs (`db:provision`);
 * 3. creates the schema with `prisma migrate deploy`, as the owner role. Never `db push`.
 *
 * The tests then connect as the application and system roles, so row-level security is
 * exercised exactly as in production. The development database `confera` is not touched.
 */
const repoRoot = join(__dirname, '..', '..', '..');
const TEST_DATABASE = 'confera_integration_test';

export default function globalSetup(): void {
  if (!existsSync(join(repoRoot, 'dist', 'main.js'))) {
    throw new Error(
      'dist/main.js is missing: run "corepack pnpm build" first (pnpm test:int does).',
    );
  }

  const urls = prepareTestDatabase(TEST_DATABASE);

  // Handed to the test files, which run in this process (--runInBand) or its children.
  process.env.CONFERA_TEST_DATABASE = urls.name;
  process.env.CONFERA_TEST_APPLICATION_URL = urls.application;
  process.env.CONFERA_TEST_SYSTEM_URL = urls.system;
  process.env.CONFERA_TEST_OWNER_URL = urls.owner;
}
