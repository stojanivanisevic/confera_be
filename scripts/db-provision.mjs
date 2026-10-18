// Creates the database roles of ADR-05 and prepares a database for `prisma migrate deploy`.
//
//   corepack pnpm db:provision                       the database of MIGRATION_DATABASE_URL
//   node scripts/db-provision.mjs --database <name>  another database on the same server
//   ... --reset                                      drop and create it again (test databases only)
//
// It is safe to run again: every step is "create if missing, then set". Roles and grants
// are not part of a database dump, so this script is also what a restore runs first.
//
// The four roles (ADR-05); this script creates the first three, the backup role arrives
// with the backup tooling (M10-BE-01):
//   confera_owner   owns the schema, runs migrations, exists only in the migration job
//   confera_app     the running API: no schema rights, bound by row-level security
//   confera_system  the resolvers: may bypass the policies, no schema rights, few grants
//
// Role names are fixed, because the committed migrations grant to them by name. Passwords
// come from the addresses in the environment (.env on a developer machine) and are never
// printed, nor sent: the server gets their SCRAM-SHA-256 verifier (M1-ISS-14).
import pg from 'pg';
import { loadDotEnv } from './lib/process.mjs';
import { scramVerifier } from './lib/scram.mjs';
import { DATABASE_VARIABLES, refuseUnlessOwnDatabase } from './lib/stack.mjs';

const ROLES = {
  owner: { name: 'confera_owner', variable: 'MIGRATION_DATABASE_URL', bypass: false },
  application: { name: 'confera_app', variable: 'DATABASE_URL', bypass: false },
  system: { name: 'confera_system', variable: 'SYSTEM_DATABASE_URL', bypass: true },
};

/** A runaway statement of the API is stopped by the database (ADR-05). */
const APPLICATION_SETTINGS = {
  statement_timeout: '15s',
  idle_in_transaction_session_timeout: '60s',
  lock_timeout: '10s',
};

const RESETTABLE_DATABASE = /^confera_[a-z0-9_]*test[a-z0-9_]*$/;

/** The name of the advisory lock that lets one provisioning run at a time on a server. */
const LOCK_NAME = 'confera db:provision';

function fail(message) {
  process.stderr.write(`db:provision failed: ${message}\n`);
  process.exit(1);
}

function parseArguments() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--database');
  return {
    database: index >= 0 ? args[index + 1] : undefined,
    reset: args.includes('--reset'),
  };
}

function readRole(kind) {
  const { name, variable } = ROLES[kind];
  const value = process.env[variable];
  if (!value) {
    fail(`${variable} is not set. Copy .env.example to .env first.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${variable} is not a valid address.`);
  }
  if (decodeURIComponent(url.username) !== name) {
    fail(`${variable} must use the role ${name}; the migrations grant to that name.`);
  }
  if (url.password === '') {
    fail(`${variable} has no password.`);
  }
  return { ...ROLES[kind], password: decodeURIComponent(url.password), url };
}

function superuserConnection(ownerUrl) {
  const explicit = process.env.PROVISION_DATABASE_URL;
  if (explicit) {
    let url;
    try {
      url = new URL(explicit);
    } catch {
      fail('PROVISION_DATABASE_URL is not a valid address.');
    }
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)) || 'postgres',
    };
  }
  const password = process.env.POSTGRES_PASSWORD;
  if (!password) {
    fail(
      'Neither PROVISION_DATABASE_URL nor POSTGRES_PASSWORD is set: no way to connect as a superuser.',
    );
  }
  // The development stack: the superuser "postgres" on the server of the owner address.
  return {
    host: ownerUrl.hostname,
    port: Number(ownerUrl.port || 5432),
    user: 'postgres',
    password,
    database: 'postgres',
  };
}

/** Codes after which the same run, started again, may well succeed: the server came back. */
const TRANSIENT = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  '57P01', // the session was ended by an administrator, or the server shut down
  '57P02', // the server is restarting after another process crashed
  '57P03', // the server is starting up, shutting down or recovering
  '08006', // the connection broke
  '08003',
]);

/** A connection that broke under a query has no code; its message says so. */
function isTransient(error) {
  return (
    TRANSIENT.has(error?.code) ||
    /Connection terminated|terminating connection|server closed the connection/i.test(
      error?.message ?? '',
    )
  );
}

/**
 * What a failure to connect means, in a sentence. Only codes are named: a message of the
 * driver can name a host, a role or a password.
 */
function connectProblem(error, database) {
  switch (error?.code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
      return `cannot reach PostgreSQL (${error.code}). Is the development stack up? Run "corepack pnpm stack:up".`;
    case '57P03':
      return 'PostgreSQL is starting up, shutting down or recovering after a crash (57P03); it did not accept connections in time. Run again in a moment.';
    case '28P01':
      return 'PostgreSQL refused the password of the superuser (28P01): check POSTGRES_PASSWORD or PROVISION_DATABASE_URL.';
    case '3D000':
      return `the database "${database ?? 'postgres'}" does not exist (3D000).`;
    case '55000':
      return `PostgreSQL does not accept connections to the database "${database ?? 'postgres'}" (55000): it is invalid after an interrupted DROP DATABASE, or does not allow connections. Drop it, or run with --reset for a test database.`;
    default:
      return `cannot connect to PostgreSQL as a superuser (${error?.code ?? 'no error code'}).`;
  }
}

/** Connects, and waits up to 30 s for a server that is starting or recovering. */
async function connect(config, database) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const client = new pg.Client(database === undefined ? config : { ...config, database });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (!isTransient(error) || Date.now() > deadline) {
        throw new ProvisionFailure(connectProblem(error, database));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** A failure that is already a sentence for the person at the terminal. */
class ProvisionFailure extends Error {}

async function provisionRole(client, role) {
  const name = client.escapeIdentifier(role.name);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role.name]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${name}`);
  }
  await client.query(
    `ALTER ROLE ${name} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${
      role.bypass ? 'BYPASSRLS' : 'NOBYPASSRLS'
    } PASSWORD ${client.escapeLiteral(scramVerifier(role.password))}`,
  );
}

async function main() {
  loadDotEnv();
  // One stack per checkout (M1-ISS-13): never provision, and never drop with --reset, a
  // database of the stack of another checkout.
  refuseUnlessOwnDatabase('db:provision', [...DATABASE_VARIABLES, 'PROVISION_DATABASE_URL']);
  const { database: requested, reset } = parseArguments();

  const owner = readRole('owner');
  const application = readRole('application');
  const system = readRole('system');
  const database = requested ?? decodeURIComponent(owner.url.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
    fail(
      `"${database}" is not a database name this script accepts (lower case, digits, underscore).`,
    );
  }
  if (reset && !RESETTABLE_DATABASE.test(database)) {
    fail(`--reset is only for test databases (confera_..._test); "${database}" is not one.`);
  }

  const superuser = superuserConnection(owner.url);
  const server = await connect(superuser);
  try {
    // One provisioning at a time on a server: the runs share the three roles, and two runs
    // that alter a role at the same moment make PostgreSQL refuse one of them ("tuple
    // concurrently updated"). The lock is held by this connection until it closes.
    await server.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME]);

    // 1. Roles and their attributes.
    for (const role of [owner, application, system]) {
      await provisionRole(server, role);
    }
    const app = server.escapeIdentifier(application.name);
    for (const [setting, value] of Object.entries(APPLICATION_SETTINGS)) {
      await server.query(`ALTER ROLE ${app} SET ${setting} = ${server.escapeLiteral(value)}`);
    }
    // No runtime role may be a member of the owner, and none of another.
    for (const role of [application, system]) {
      await server.query(
        `REVOKE ${server.escapeIdentifier(owner.name)} FROM ${server.escapeIdentifier(role.name)}`,
      );
    }

    // 2. The database, owned by the owner role, closed to everyone else.
    const db = server.escapeIdentifier(database);
    if (reset) {
      await server.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
    // A DROP DATABASE that was interrupted (the server stopped or crashed in the middle of
    // it) leaves the database behind marked invalid (datconnlimit -2, PostgreSQL 16 and
    // later): nobody can connect to it ("cannot connect to invalid database", 55000) and
    // the only thing PostgreSQL allows is to drop it. It holds nothing that could be read
    // any more, so it is dropped and created again.
    const invalid = await server.query(
      'SELECT 1 FROM pg_database WHERE datname = $1 AND datconnlimit = -2',
      [database],
    );
    if (invalid.rowCount > 0) {
      process.stdout.write(
        `Database "${database}" was left invalid by an interrupted DROP DATABASE; it is dropped and created again.\n`,
      );
      await server.query(`DROP DATABASE ${db} WITH (FORCE)`);
    }
    const found = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (found.rowCount === 0) {
      await server.query(
        `CREATE DATABASE ${db} OWNER ${server.escapeIdentifier(owner.name)} ENCODING 'UTF8' TEMPLATE template0`,
      );
    }
    await server.query(`ALTER DATABASE ${db} OWNER TO ${server.escapeIdentifier(owner.name)}`);
    await server.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    for (const role of [application, system]) {
      const name = server.escapeIdentifier(role.name);
      await server.query(`REVOKE ALL ON DATABASE ${db} FROM ${name}`);
      await server.query(`GRANT CONNECT ON DATABASE ${db} TO ${name}`);
    }

    // 3. The schema: the owner owns it; the runtime roles may use it and create nothing in it.
    const inside = await connect(superuser, database);
    try {
      const ownerName = inside.escapeIdentifier(owner.name);
      await inside.query(`ALTER SCHEMA public OWNER TO ${ownerName}`);
      await inside.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      for (const role of [application, system]) {
        const name = inside.escapeIdentifier(role.name);
        await inside.query(`REVOKE ALL ON SCHEMA public FROM ${name}`);
        await inside.query(`GRANT USAGE ON SCHEMA public TO ${name}`);
      }
    } finally {
      await inside.end();
    }
  } finally {
    await server.end();
  }

  process.stdout.write(
    [
      `Database "${database}" is provisioned.`,
      `  owner        ${owner.name}  (migrations only)`,
      `  application  ${application.name}  (no schema rights, bound by row-level security)`,
      `  system       ${system.name}  (resolvers only, may bypass row-level security)`,
      'Next: corepack pnpm db:migrate',
      '',
    ].join('\n'),
  );
}

// Every step is "create if missing, then set", so a run that lost its connection (the
// server restarted, or the stack was stopped and started) is simply run again, up to
// three times. Anything else ends the run at once.
for (let attempt = 1; ; attempt += 1) {
  try {
    await main();
    break;
  } catch (error) {
    if (error instanceof ProvisionFailure) {
      fail(error.message);
    }
    if (attempt < 3 && isTransient(error)) {
      process.stdout.write(
        `The connection to PostgreSQL was lost (${error?.code ?? 'connection ended'}): PostgreSQL restarted or was stopped. Provisioning starts again (attempt ${String(attempt + 1)} of 3).\n`,
      );
      continue;
    }
    // A plain sentence, not a stack trace. The code of PostgreSQL says what kind of failure it was.
    const code = typeof error?.code === 'string' ? ` (PostgreSQL ${error.code})` : '';
    fail(
      `provisioning did not finish: ${error instanceof Error ? error.message : 'unknown error'}${code}. It is safe to run again.`,
    );
  }
}
