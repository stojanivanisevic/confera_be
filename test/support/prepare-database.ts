import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Creates a test database the way a developer creates the development one (ADR-24):
 *
 * 1. reads `.env` (the addresses of the development stack);
 * 2. drops and creates the database with the roles of ADR-05, through the same script a
 *    developer runs (`db:provision`);
 * 3. creates the schema with `prisma migrate deploy`, as the owner role. Never `db push`.
 *
 * Each test tier has a database of its own, so the tiers cannot disturb each other, and
 * the development database `confera` is never touched.
 */
const repoRoot = join(__dirname, '..', '..');

export interface TestDatabaseUrls {
  readonly name: string;
  /** Address as confera_app: no schema rights, bound by row-level security. */
  readonly application: string;
  /** Address as confera_system: may bypass the policies, few grants. */
  readonly system: string;
  /** Address as confera_owner: owns the schema. */
  readonly owner: string;
}

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

export function loadDotEnv(): void {
  const envFile = join(repoRoot, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

export function prepareTestDatabase(name: string): TestDatabaseUrls {
  loadDotEnv();
  for (const variable of ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
    if (!process.env[variable]) {
      throw new Error(
        `${variable} is not set. Copy .env.example to .env and start the stack: corepack pnpm stack:up`,
      );
    }
  }

  const urls: TestDatabaseUrls = {
    name,
    application: withDatabase(process.env.DATABASE_URL ?? '', name),
    system: withDatabase(process.env.SYSTEM_DATABASE_URL ?? '', name),
    owner: withDatabase(process.env.MIGRATION_DATABASE_URL ?? '', name),
  };

  run(
    `db:provision of the database ${name}`,
    [join('scripts', 'db-provision.mjs'), '--database', name, '--reset'],
    process.env,
  );
  run(
    `prisma migrate deploy on the database ${name}`,
    [join('node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    { ...process.env, MIGRATION_DATABASE_URL: urls.owner },
  );
  return urls;
}
