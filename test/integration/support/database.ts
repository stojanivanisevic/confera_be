import { randomBytes, randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';

/**
 * Access to the integration-test database, which global-setup.ts created with
 * `db:provision` and `prisma migrate deploy`.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: the integration tests run through "pnpm test:int".`);
  }
  return value;
}

export const testDatabase = {
  get name(): string {
    return required('CONFERA_TEST_DATABASE');
  },
  /** Address as confera_app: no schema rights, bound by row-level security. */
  get applicationUrl(): string {
    return required('CONFERA_TEST_APPLICATION_URL');
  },
  /** Address as confera_system: may bypass the policies, few grants. */
  get systemUrl(): string {
    return required('CONFERA_TEST_SYSTEM_URL');
  },
  /** Address as confera_owner: owns the schema. */
  get ownerUrl(): string {
    return required('CONFERA_TEST_OWNER_URL');
  },
};

/** A connection as the PostgreSQL superuser of the development stack, for fixtures and the catalogue. */
export async function connectAsSuperuser(): Promise<Client> {
  const owner = new URL(testDatabase.ownerUrl);
  const client = new Client({
    host: owner.hostname,
    port: Number(owner.port || 5432),
    user: 'postgres',
    password: required('POSTGRES_PASSWORD'),
    database: testDatabase.name,
  });
  await client.connect();
  return client;
}

export async function connect(address: string): Promise<Client> {
  const client = new Client({ connectionString: address });
  await client.connect();
  return client;
}

/** The address of `base` with another role and password. */
export function addressFor(base: string, role: string, password: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  return url.toString();
}

export function randomPassword(prefix = 'invented'): string {
  return `${prefix}-${randomBytes(12).toString('hex')}`;
}

export async function rows<T extends QueryResultRow>(
  client: Client,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(sql, values)).rows;
}

/** Runs `work` in a transaction with the organisation set as the tenant client sets it. */
export async function inOrganisation<T>(
  client: Client,
  organisationId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (organisationId !== null) {
      await client.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
    }
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export interface SeededOrganisation {
  readonly id: string;
  readonly name: string;
  readonly users: readonly { id: string; email: string; displayName: string }[];
}

export interface TwoOrganisations {
  readonly a: SeededOrganisation;
  readonly b: SeededOrganisation;
}

/**
 * Two organisations with invented people on example.test (NFR-PRIV-05), written by the
 * superuser. The names carry š č ć ž đ, as real ones will.
 */
export async function seedTwoOrganisations(superuser: Client): Promise<TwoOrganisations> {
  await superuser.query('TRUNCATE "user_roles", "users", "organisations" CASCADE');

  const make = async (
    name: string,
    people: readonly [displayName: string, email: string, role: string][],
  ): Promise<SeededOrganisation> => {
    const id = randomUUID();
    await superuser.query('INSERT INTO organisations (id, name) VALUES ($1, $2)', [id, name]);
    const users = [];
    for (const [displayName, email, role] of people) {
      const userId = randomUUID();
      await superuser.query(
        'INSERT INTO users (id, organisation_id, email, display_name, password_hash) VALUES ($1, $2, $3, $4, $5)',
        [userId, id, email, displayName, `invented-hash-of-${email}`],
      );
      await superuser.query(
        'INSERT INTO user_roles (organisation_id, user_id, role) VALUES ($1, $2, $3)',
        [id, userId, role],
      );
      users.push({ id: userId, email, displayName });
    }
    return { id, name, users };
  };

  return {
    a: await make('Udruženje A (izmišljeno)', [
      ['Živana Đorđević', 'zivana.djordjevic@a.example.test', 'admin'],
      ['Časlav Šćepanović', 'caslav.scepanovic@a.example.test', 'reviewer'],
      ['Mila Petrović', 'mila.petrovic@a.example.test', 'reviewer'],
    ]),
    b: await make('Udruženje B (izmišljeno)', [
      ['Đorđe Žikić', 'djordje.zikic@b.example.test', 'admin'],
      ['Ana Čolić', 'ana.colic@b.example.test', 'reviewer'],
    ]),
  };
}

/** Runs a statement that must fail and returns the PostgreSQL error code (SQLSTATE). */
export async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'no-error';
}

/** SQLSTATE codes these tests expect. */
export const SQLSTATE = {
  insufficientPrivilege: '42501',
  foreignKeyViolation: '23503',
  invalidTextRepresentation: '22P02',
} as const;
