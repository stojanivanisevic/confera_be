// `pnpm first-admin`: the first admin of an organisation, as an invitation only
// (M2-BE-11, ADR-03, ADR-24, SEC-A-27; ST-27).
//
//   corepack pnpm first-admin --email ana.admin@example.org --name "Ana Admin"
//
// Creates the person as invited (no password), gives them the admin role and makes an
// invitation link valid for 72 hours. The link is printed ONCE, to this terminal, and
// nowhere else: not to a log, not to a file, not to the database (which keeps its
// SHA-256 only). The person opens it and sets their own password; nobody else ever knows
// it. Refused when the organisation has an active admin: from then on admins invite in
// the application. Run again for a person still invited, it makes a new link and the
// earlier one stops working.
//
// Needs MIGRATION_DATABASE_URL (the owner role) and ADMIN_ORIGIN (where the link leads).
// The organisation is the one of the production seed unless --organisation names another.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { repoRoot } from './lib/process.mjs';
import { inOrganisation, requireAnyStage } from './lib/seed-data.mjs';
import { refuseUnlessOwnDatabase } from './lib/stack.mjs';

const TOOL = 'first-admin';
const LIFETIME_MS = 72 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message, code = 1) {
  process.stderr.write(`${TOOL} did not run: ${message}\n`);
  process.exit(code);
}

/** The address rule of the application (ST-23): one address, no name, no list. */
function isAddress(value) {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    // eslint-disable-next-line no-control-regex
    !/[\s,;<>"\u0000-\u001F\u007F]/.test(value) &&
    /^[^@]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
      value,
    )
  );
}

function isName(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001F\u007F<>]/.test(value)
  );
}

async function main() {
  const stage = requireAnyStage(TOOL);
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        organisation: { type: 'string' },
      },
    }));
  } catch {
    fail('usage: first-admin --email <address> --name "<display name>" [--organisation <id>]', 2);
  }
  if (!isAddress(values.email)) {
    fail('--email must be one address.', 2);
  }
  if (!isName(values.name)) {
    fail('--name must be a name of at most 200 characters.', 2);
  }
  const email = values.email.toLowerCase();
  const organisationId =
    values.organisation ??
    JSON.parse(readFileSync(path.join(repoRoot, 'prisma', 'seed', 'production.json'), 'utf8'))
      .organisation.id;
  if (!UUID.test(organisationId)) {
    fail('--organisation must be the id of an organisation.', 2);
  }
  const origin = process.env.ADMIN_ORIGIN;
  if (!origin || !/^https?:\/\/[^/\s]+$/.test(origin)) {
    fail('ADMIN_ORIGIN is not set: the link needs the address of the admin application.', 78);
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

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  let outcome;
  try {
    outcome = await inOrganisation(client, organisationId, async () => {
      const organisation = await client.query('SELECT id FROM organisations WHERE id = $1', [
        organisationId,
      ]);
      if (organisation.rowCount !== 1) {
        return 'no_organisation';
      }
      // Two runs at once are taken one after the other.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('confera first admin ' || $1, 0))",
        [organisationId],
      );
      const admins = await client.query(
        `SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id AND r.organisation_id = u.organisation_id
         WHERE u.status = 'active' AND r.role = 'admin' LIMIT 1`,
      );
      if (admins.rowCount > 0) {
        return 'has_admin';
      }
      const existing = await client.query('SELECT id, status FROM users WHERE email = $1', [email]);
      let userId = existing.rows[0]?.id;
      if (existing.rowCount > 0 && existing.rows[0].status !== 'invited') {
        return 'not_invited';
      }
      if (userId === undefined) {
        const created = await client.query(
          `INSERT INTO users (organisation_id, email, display_name, status)
           VALUES ($1, $2, $3, 'invited') RETURNING id`,
          [organisationId, email, values.name.trim()],
        );
        userId = created.rows[0].id;
        await client.query(
          "INSERT INTO user_roles (organisation_id, user_id, role) VALUES ($1, $2, 'admin')",
          [organisationId, userId],
        );
      }
      const now = new Date();
      await client.query(
        `UPDATE secure_links SET revoked_at = $3
         WHERE purpose = 'invitation' AND user_id = $1 AND recipient = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [userId, email, now],
      );
      await client.query(
        `INSERT INTO secure_links (organisation_id, purpose, token_hash, user_id, recipient, created_at, expires_at)
         VALUES ($1, 'invitation', $2, $3, $4, $5, $6)`,
        [organisationId, tokenHash, userId, email, now, new Date(now.getTime() + LIFETIME_MS)],
      );
      await client.query(
        `INSERT INTO audit_entries (organisation_id, actor_user_id, action, subject_type, subject_id, detail)
         VALUES ($1, NULL, 'user.invited', 'user', $2, '{"firstAdmin": true}')`,
        [organisationId, userId],
      );
      return 'invited';
    });
  } catch (error) {
    fail(
      `the database refused the invitation (${error.code ?? 'no error code'}). Is the schema up to date?`,
    );
  } finally {
    await client.end();
  }
  if (outcome === 'no_organisation') {
    fail('the organisation does not exist. Run "corepack pnpm seed:production" first.');
  }
  if (outcome === 'has_admin') {
    fail('the organisation has an active admin already; admins invite in the application.');
  }
  if (outcome === 'not_invited') {
    fail('a person with this address exists and is not invited.');
  }
  // The one place the link exists: this terminal. Copy it to the person by hand.
  process.stdout.write(
    [
      `${TOOL}: ${email} is invited as admin (STAGE=${stage}).`,
      'The invitation link, valid for 72 hours, is shown this once and kept nowhere:',
      '',
      `  ${origin}/invitations/${token}`,
      '',
    ].join('\n'),
  );
}

await main();
