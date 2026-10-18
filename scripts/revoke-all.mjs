// `pnpm sessions:revoke-all`: the operator's global revoke (M2-ISS-12, ADR-03): after a
// suspected leak, every session of an organisation ends at once, every secure link not yet
// used stops working, and every queued message that would make a link is ended.
//
//   corepack pnpm sessions:revoke-all --yes [--organisation <id>]
//
// People sign in again; an invited person asks for a new invitation, which an admin sends
// once signed in again (the first admin with `first-admin`). One audit entry says what was
// done and how much. Nothing is deleted.
//
// Needs MIGRATION_DATABASE_URL (the owner role). The organisation is the one of the
// production seed unless --organisation names another. Refused without --yes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { repoRoot } from './lib/process.mjs';
import { inOrganisation, requireAnyStage } from './lib/seed-data.mjs';
import { refuseUnlessOwnDatabase } from './lib/stack.mjs';

const TOOL = 'sessions:revoke-all';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message, code = 1) {
  process.stderr.write(`${TOOL} did not run: ${message}\n`);
  process.exit(code);
}

async function main() {
  const stage = requireAnyStage(TOOL);
  let values;
  try {
    ({ values } = parseArgs({
      options: { organisation: { type: 'string' }, yes: { type: 'boolean' } },
    }));
  } catch {
    fail('usage: sessions:revoke-all --yes [--organisation <id>]', 2);
  }
  if (values.yes !== true) {
    fail('it ends every session and link of the organisation; say --yes to do it.', 2);
  }
  const organisationId =
    values.organisation ??
    JSON.parse(readFileSync(path.join(repoRoot, 'prisma', 'seed', 'production.json'), 'utf8'))
      .organisation.id;
  if (!UUID.test(organisationId)) {
    fail('--organisation must be the id of an organisation.', 2);
  }
  const address = process.env.MIGRATION_DATABASE_URL;
  if (!address) {
    fail('MIGRATION_DATABASE_URL is not set.', 78);
  }
  if (stage !== 'prod') {
    refuseUnlessOwnDatabase(TOOL, ['MIGRATION_DATABASE_URL']);
  }
  const client = new pg.Client({ connectionString: address });
  try {
    await client.connect();
  } catch (error) {
    fail(`cannot connect to PostgreSQL as the owner role (${error.code ?? 'no error code'}).`);
  }
  let counts;
  try {
    counts = await inOrganisation(client, organisationId, async () => {
      const organisation = await client.query('SELECT id FROM organisations WHERE id = $1', [
        organisationId,
      ]);
      if (organisation.rowCount !== 1) {
        return null;
      }
      const now = new Date();
      const sessions = await client.query(
        `UPDATE sessions SET ended_at = $1, end_reason = 'global_revoke' WHERE ended_at IS NULL`,
        [now],
      );
      const links = await client.query(
        'UPDATE secure_links SET revoked_at = $1 WHERE used_at IS NULL AND revoked_at IS NULL',
        [now],
      );
      const messages = await client.query(
        `UPDATE mail_outbox SET status = 'failed', last_error_code = 'superseded', claimed_at = NULL
         WHERE link_purpose IS NOT NULL AND status IN ('queued', 'waiting_for_server', 'held')`,
      );
      const total = sessions.rowCount + links.rowCount + messages.rowCount;
      await client.query(
        `INSERT INTO audit_entries (organisation_id, actor_user_id, action, subject_type, subject_id, detail)
         VALUES ($1, NULL, 'instance.global_revoke', 'organisation', $1, $2)`,
        [organisationId, JSON.stringify({ count: total })],
      );
      return { sessions: sessions.rowCount, links: links.rowCount, messages: messages.rowCount };
    });
  } catch (error) {
    fail(`the database refused it (${error.code ?? 'no error code'}). Is the schema up to date?`);
  } finally {
    await client.end();
  }
  if (counts === null) {
    fail('the organisation does not exist.');
  }
  process.stdout.write(
    `${TOOL}: ended ${String(counts.sessions)} sessions, ${String(counts.links)} secure links and ${String(counts.messages)} queued link messages (STAGE=${stage}).\n`,
  );
}

await main();
