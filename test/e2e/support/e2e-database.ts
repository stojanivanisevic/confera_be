import { Client, type QueryResultRow } from 'pg';

/**
 * The database of the end-to-end tests, which global-setup.ts created with
 * `db:provision` and `prisma migrate deploy`.
 *
 * The application under test connects as the application role. The tests themselves
 * write their fixtures as the owner role, inside an organisation (see factories.ts), and
 * never as a superuser: what a test puts into the database went through the policies too.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: the end-to-end tests run through "pnpm test:e2e".`);
  }
  return value;
}

export const e2eDatabase = {
  get name(): string {
    return required('CONFERA_E2E_DATABASE');
  },
  /** Address as confera_app: what the application under test uses. */
  get applicationUrl(): string {
    return required('CONFERA_E2E_APPLICATION_URL');
  },
  /** Address as confera_system: the resolvers of the application under test. */
  get systemUrl(): string {
    return required('CONFERA_E2E_SYSTEM_URL');
  },
  /** Address as confera_owner: fixtures and the seed. */
  get ownerUrl(): string {
    return required('CONFERA_E2E_OWNER_URL');
  },
};

export async function connect(address: string): Promise<Client> {
  const client = new Client({ connectionString: address });
  await client.connect();
  return client;
}

export function connectAsOwner(): Promise<Client> {
  return connect(e2eDatabase.ownerUrl);
}

export async function rows<T extends QueryResultRow>(
  client: Client,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(sql, values)).rows;
}
