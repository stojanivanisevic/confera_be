// `pnpm seed:production`: what a fresh installation starts from (M2-BE-11, FR-CONF-02,
// ADR-24, SEC-A-27; ST-27).
//
//   corepack pnpm seed:production
//
// Writes the organisation of prisma/seed/production.json, its default email templates in
// English and Serbian, and the five conferences as drafts with their codes and websites.
// It writes NO user and no password: the first admin is invited with `pnpm first-admin`.
// No price, discount, edition or date either: those are data an admin enters.
//
// Runs as the owner role (MIGRATION_DATABASE_URL), inside the organisation, so the write
// check of row-level security applies to the seed too. Safe to run again: what exists is
// left as it is, an admin's edits included.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { repoRoot } from './lib/process.mjs';
import {
  inOrganisation,
  requireAnyStage,
  seedAbstractForms,
  seedTemplates,
} from './lib/seed-data.mjs';
import { refuseUnlessOwnDatabase } from './lib/stack.mjs';

const TOOL = 'seed:production';

function fail(message) {
  process.stderr.write(`${TOOL} failed: ${message}\n`);
  process.exit(1);
}

async function main() {
  const stage = requireAnyStage(TOOL);
  const address = process.env.MIGRATION_DATABASE_URL;
  if (!address) {
    fail('MIGRATION_DATABASE_URL is not set.');
  }
  if (stage !== 'prod') {
    // One stack per checkout: never write into the database of another checkout.
    refuseUnlessOwnDatabase(TOOL, ['MIGRATION_DATABASE_URL']);
  }
  const seed = JSON.parse(
    readFileSync(path.join(repoRoot, 'prisma', 'seed', 'production.json'), 'utf8'),
  );
  const { organisation, conferences } = seed;

  const client = new pg.Client({ connectionString: address });
  try {
    await client.connect();
  } catch (error) {
    fail(`cannot connect to PostgreSQL as the owner role (${error.code ?? 'no error code'}).`);
  }
  let summary;
  try {
    summary = await inOrganisation(client, organisation.id, async () => {
      await client.query(
        'INSERT INTO organisations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [organisation.id, organisation.name],
      );
      const templates = await seedTemplates(client, organisation.id);
      let drafts = 0;
      for (const conference of conferences) {
        const result = await client.query(
          `INSERT INTO conferences (organisation_id, name, code, listed_sites, languages, state)
           VALUES ($1, $2, $3, ARRAY[$4]::text[], ARRAY['en', 'sr']::text[], 'draft')
           ON CONFLICT DO NOTHING`,
          [organisation.id, conference.name, conference.code, conference.site],
        );
        drafts += result.rowCount ?? 0;
      }
      const forms = await seedAbstractForms(client, organisation.id);
      return { templates, drafts, forms };
    });
  } catch (error) {
    fail(
      `the database refused the seed (${error.code ?? 'no error code'}). Is the schema up to date? Run "corepack pnpm db:migrate".`,
    );
  } finally {
    await client.end();
  }
  process.stdout.write(
    `${TOOL}: "${organisation.name}" is in place with ${String(summary.templates)} new templates, ${String(summary.drafts)} new conference drafts and ${String(summary.forms)} new abstract forms, unpublished (STAGE=${stage}). No user was created; invite the first admin with "corepack pnpm first-admin".\n`,
  );
}

await main();
