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
// Each person has the invented password of that file (it starts with `invented-`), hashed
// as the application hashes it, so that the sign-in tests of the web application can sign
// in; the default email templates are written for each organisation. Both exist only on
// the stages this tool runs on.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { repoRoot } from './lib/process.mjs';
import { seedAbstractForms, seededAbstractDefinition, seedTemplates } from './lib/seed-data.mjs';
import { refuseUnlessOwnDatabase } from './lib/stack.mjs';
import { requireStage } from './lib/stage.mjs';

const TOOL = 'seed:e2e';
const SEED_STAGES = ['local', 'test'];
const INVENTED_DOMAIN = 'example.test';
const SEED_FILE = path.join(repoRoot, 'test', 'e2e', 'seed', 'e2e-seed.json');
const PLACEHOLDER_PREFIX = 'invented-';
/** The parameters of src/modules/access/password-hasher.ts (argon2id, 19 MiB, 2 passes). */
const HASH_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

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
      if (user.password !== undefined && !user.password.startsWith(PLACEHOLDER_PREFIX)) {
        fail(
          `a seeded password does not start with ${PLACEHOLDER_PREFIX}; the seed holds invented ones only.`,
        );
      }
    }
  }
  return seed;
}

/**
 * A conference of the end-to-end tests of the web application (M3): open for submissions,
 * with its deadline and its abstract form published under a fixed address, so that the
 * hosted form, the frame page and the snippet can be tried against the real API.
 */
async function seedConference(client, organisationId, conference, publisherId) {
  await client.query(
    `INSERT INTO conferences (id, organisation_id, name, code, edition_year, listed_sites, languages, state)
     VALUES ($1, $2, $3, $4, $5, $6::text[], ARRAY['en', 'sr']::text[], $7)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, listed_sites = EXCLUDED.listed_sites,
       state = EXCLUDED.state`,
    [
      conference.id,
      organisationId,
      conference.name,
      conference.code,
      conference.editionYear,
      conference.listedSites,
      conference.state,
    ],
  );
  await client.query(
    `INSERT INTO conference_deadlines (organisation_id, conference_id, kind, ends_on)
     VALUES ($1, $2, 'abstract_submission', $3)
     ON CONFLICT (organisation_id, conference_id, kind) DO UPDATE SET ends_on = EXCLUDED.ends_on`,
    [organisationId, conference.id, conference.abstractDeadline],
  );
  const form = conference.form;
  await client.query(
    `INSERT INTO forms (id, organisation_id, conference_id, type, public_key, configuration)
     VALUES ($1, $2, $3, 'abstract', $4, '{}') ON CONFLICT (id) DO NOTHING`,
    [form.id, organisationId, conference.id, form.slug],
  );
  // Published by the seeded admin, as a publish through the API would be: every version
  // names its publisher (the column is NOT NULL, the contract says publishedBy is never null).
  const version = await client.query(
    `INSERT INTO form_versions (organisation_id, form_id, number, definition, published_by)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (organisation_id, form_id, number) DO UPDATE SET published_by = EXCLUDED.published_by
     RETURNING id`,
    [organisationId, form.id, JSON.stringify(seededAbstractDefinition()), publisherId],
  );
  await client.query('UPDATE forms SET current_version_id = $1 WHERE id = $2', [
    version.rows[0].id,
    form.id,
  ]);
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
      const passwordHash =
        user.password === undefined ? null : await hash(user.password, HASH_OPTIONS);
      await client.query(
        `INSERT INTO users (id, organisation_id, email, display_name, status, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
           status = EXCLUDED.status, password_hash = EXCLUDED.password_hash`,
        [
          user.id,
          organisation.id,
          user.email,
          user.displayName,
          passwordHash === null ? 'invited' : 'active',
          passwordHash,
        ],
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
    await seedTemplates(client, organisation.id);
    const conferences = organisation.conferences ?? [];
    const publisher = organisation.users.find((user) => user.role === 'admin');
    if (conferences.length > 0 && publisher === undefined) {
      throw new Error('an organisation with a conference has no admin to publish its form');
    }
    for (const conference of conferences) {
      await seedConference(client, organisation.id, conference, publisher.id);
    }
    await seedAbstractForms(client, organisation.id);
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
  // One stack per checkout (M1-ISS-13): never write into the database of another checkout.
  refuseUnlessOwnDatabase(TOOL, ['MIGRATION_DATABASE_URL']);
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
