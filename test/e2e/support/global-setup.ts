import { prepareTestDatabase } from '../../support/prepare-database';
import { startTrace } from './trace';

/**
 * Runs once before the end-to-end tests (`pnpm test:e2e`): creates the database
 * `confera_e2e_test` with `db:provision` and `prisma migrate deploy`, exactly as a
 * developer creates the development database. The tests start the real application on
 * it, connected as the application role, so row-level security is always in force.
 *
 * Needs the development stack (`pnpm stack:up`). The development database `confera` and
 * the database of the integration tests are not touched.
 */
const E2E_DATABASE = 'confera_e2e_test';

export default function globalSetup(): void {
  const urls = prepareTestDatabase(E2E_DATABASE);
  startTrace();

  // Handed to the test files, which run in this process (--runInBand) or its children.
  process.env.CONFERA_E2E_DATABASE = urls.name;
  process.env.CONFERA_E2E_APPLICATION_URL = urls.application;
  process.env.CONFERA_E2E_SYSTEM_URL = urls.system;
  process.env.CONFERA_E2E_OWNER_URL = urls.owner;
}
