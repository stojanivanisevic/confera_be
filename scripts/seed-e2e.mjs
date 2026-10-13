// `pnpm seed:e2e`: the known state the end-to-end tests of both repositories start from
// (ADR-24, M1-QA-02). Invented organisations and invented people on example.test.
//
//   corepack pnpm seed:e2e
//
// A TEST TOOL. It refuses to run unless STAGE is exactly `local` or `test`, before it
// reads anything else and before it opens a connection: on a server (every server runs
// STAGE=prod) and on a missing or misspelt stage it ends with exit code 78.
//
// It writes as the owner role (MIGRATION_DATABASE_URL), inside each organisation
// (`app.org_id` set for the transaction), so the write check of row-level security
// applies to the seed too. Safe to run again: the same rows, never a second copy.
//
// The data is test/e2e/seed/e2e-seed.json; tests of both repositories read the same file.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { repoRoot } from './lib/process.mjs';
import { requireStage } from './lib/stage.mjs';

const TOOL = 'seed:e2e';
const SEED_STAGES = ['local', 'test'];
const INVENTED_DOMAIN = 'example.test';
const SEED_FILE = path.join(repoRoot, 'test', 'e2e', 'seed', 'e2e-seed.json');

function fail(message) {
  process.stderr.write(`${TOOL} failed: ${message}\n`);
  process.exit(1);
}

function readSeed() {
  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
  for (const organisation of seed.organisations) {
    for (const user of organisation.users) {
      const domain = user.email.slice(user.email.lastIndexOf('@') + 1);
      if (domain !== INVENTED_DOMAIN && !domain.endsWith(`.${INVENTED_DOMAIN}`)) {
        fail(`a seeded person is not on ${INVENTED_DOMAIN}; the seed holds invented people only.`);
      }
    }
  }
  return seed;
}

async function seedOrganisation(client, organisation) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.org_id', $1, true)", [organisation.id]);
    await client.query(
      `INSERT INTO organisations (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [organisation.id, organisation.name],
    );
    for (const user of organisation.users) {
      await client.query(
        `INSERT INTO users (id, organisation_id, email, display_name) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`,
        [user.id, organisation.id, user.email, user.displayName],
      );
      await client.query('DELETE FROM user_roles WHERE organisation_id = $1 AND user_id = $2', [
        organisation.id,
        user.id,
      ]);
      await client.query(
        'INSERT INTO user_roles (organisation_id, user_id, role) VALUES ($1, $2, $3)',
        [organisation.id, user.id, user.role],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  // First of all, and before any other variable is read.
  const stage = requireStage(TOOL, SEED_STAGES);

  const address = process.env.MIGRATION_DATABASE_URL;
  if (!address) {
    fail('MIGRATION_DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  const seed = readSeed();

  const client = new pg.Client({ connectionString: address });
  try {
    await client.connect();
  } catch (error) {
    // Only the error code is printed: it names no host, role or password.
    fail(
      `cannot connect to PostgreSQL as the owner role (${error.code ?? 'no error code'}). Is the stack up, and were "db:provision" and "db:migrate" run?`,
    );
  }
  let database;
  try {
    database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    for (const organisation of seed.organisations) {
      await seedOrganisation(client, organisation);
    }
  } catch (error) {
    fail(
      `the database refused the seed (${error.code ?? 'no error code'}). Is the schema up to date? Run "corepack pnpm db:migrate".`,
    );
  } finally {
    await client.end();
  }

  const people = seed.organisations.reduce((sum, { users }) => sum + users.length, 0);
  process.stdout.write(
    `${TOOL}: ${String(seed.organisations.length)} organisations and ${String(people)} invented people on ${INVENTED_DOMAIN} are in the database "${database}" (STAGE=${stage}).\n`,
  );
}

await main();
