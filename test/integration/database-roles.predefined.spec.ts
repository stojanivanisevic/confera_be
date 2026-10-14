import type { Client } from 'pg';
import {
  describeRole,
  REFUSED_PREDEFINED_ROLES,
  roleProblems,
} from '../../src/platform/prisma/database-role';
import { createBaseClient } from '../../src/platform/prisma/tenant-client';
import {
  addressFor,
  connectAsSuperuser,
  randomPassword,
  rows,
  testDatabase,
} from './support/database';

/**
 * The predefined roles of PostgreSQL in the start-up role check (ADR-05, ST-08; the
 * verification of E1 found pg_read_server_files and its two companions let through).
 *
 * For every predefined role of this server: an application role and a system role that
 * are members of it are refused. And the list in database-role.ts is the list of the
 * server, so a version of PostgreSQL that adds a role fails here until it is decided.
 */

describe('the predefined roles of PostgreSQL in the start-up role check', () => {
  jest.setTimeout(180_000);

  const password = randomPassword();
  const REFUSED = Object.keys(REFUSED_PREDEFINED_ROLES);
  /** One login role per predefined role and kind: confera_test_pre_<a|s>_<n>. */
  const loginRole = (kind: 'a' | 's', index: number) => `confera_test_pre_${kind}_${String(index)}`;
  let superuser: Client;

  const drop = async (): Promise<void> => {
    const existing = await rows<{ rolname: string }>(
      superuser,
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'confera_test_pre_%'",
    );
    for (const { rolname } of existing) {
      await superuser.query(`REVOKE ALL ON DATABASE ${testDatabase.name} FROM ${rolname}`);
      await superuser.query(`DROP ROLE ${rolname}`);
    }
  };

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
    await drop();
    const pw = superuser.escapeLiteral(password);
    for (const [index, predefined] of REFUSED.entries()) {
      for (const [kind, runtime] of [
        ['a', 'confera_app'],
        ['s', 'confera_system'],
      ] as const) {
        const role = loginRole(kind, index);
        await superuser.query(
          `CREATE ROLE ${role} LOGIN PASSWORD ${pw} IN ROLE ${runtime}, ${predefined}`,
        );
        await superuser.query(`GRANT CONNECT ON DATABASE ${testDatabase.name} TO ${role}`);
      }
    }
  });

  afterAll(async () => {
    await drop();
    await superuser.end();
  });

  it('the list of the check is the list of predefined roles of this server', async () => {
    const server = await rows<{ rolname: string }>(
      superuser,
      "SELECT rolname FROM pg_roles WHERE left(rolname, 3) = 'pg_' AND rolname <> 'pg_database_owner' ORDER BY 1",
    );
    expect(server.map(({ rolname }) => rolname)).toEqual([...REFUSED].sort());
  });

  it.each(REFUSED.map((name, index) => [name, index] as const))(
    'refuses an application role and a system role that are members of %s',
    async (predefined, index) => {
      for (const [kind, letter] of [
        ['application', 'a'],
        ['system', 's'],
      ] as const) {
        const client = createBaseClient(
          addressFor(testDatabase.applicationUrl, loginRole(letter, index), password),
          { poolSize: 1 },
        );
        try {
          const role = await describeRole(client);
          expect(role.memberOfPredefined).toContain(predefined);
          expect(roleProblems(kind, role).join(' ')).toContain(`${predefined}:`);
        } finally {
          await client.$disconnect();
        }
      }
    },
  );
});
