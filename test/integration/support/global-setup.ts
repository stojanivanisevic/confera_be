import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

function withDatabase(address: string, database: string): string {
  const url = new URL(address);
  url.pathname = `/${database}`;
  return url.toString();
}

function run(title: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${title} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

export default function globalSetup(): void {
  const envFile = join(repoRoot, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  for (const name of ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
    if (!process.env[name]) {
      throw new Error(
        `${name} is not set. Copy .env.example to .env and start the stack: corepack pnpm stack:up`,
      );
    }
  }
  if (!existsSync(join(repoRoot, 'dist', 'main.js'))) {
    throw new Error(
      'dist/main.js is missing: run "corepack pnpm build" first (pnpm test:int does).',
    );
  }

  const urls = {
    application: withDatabase(process.env.DATABASE_URL ?? '', TEST_DATABASE),
    system: withDatabase(process.env.SYSTEM_DATABASE_URL ?? '', TEST_DATABASE),
    owner: withDatabase(process.env.MIGRATION_DATABASE_URL ?? '', TEST_DATABASE),
  };

  run(
    'db:provision of the test database',
    [join('scripts', 'db-provision.mjs'), '--database', TEST_DATABASE, '--reset'],
    process.env,
  );
  run(
    'prisma migrate deploy on the test database',
    [join('node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    { ...process.env, MIGRATION_DATABASE_URL: urls.owner },
  );

  // Handed to the test files, which run in this process (--runInBand) or its children.
  process.env.CONFERA_TEST_DATABASE = TEST_DATABASE;
  process.env.CONFERA_TEST_APPLICATION_URL = urls.application;
  process.env.CONFERA_TEST_SYSTEM_URL = urls.system;
  process.env.CONFERA_TEST_OWNER_URL = urls.owner;
}
