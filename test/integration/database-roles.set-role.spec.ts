import type { Client } from 'pg';
import { describeRole, roleProblems } from '../../src/platform/prisma/database-role';
import { createBaseClient } from '../../src/platform/prisma/tenant-client';
import {
  addressFor,
  connectAsSuperuser,
  randomPassword,
  rows,
  testDatabase,
} from './support/database';

/**
 * A role that reaches a refused role ONLY through SET ROLE, never by inheritance, is
 * refused too. The check asks pg_has_role(..., 'MEMBER'); 'USAGE' would see inherited
 * rights only, and these roles have none. Without this file, narrowing the check to
 * USAGE passed every test (found in the verification of the predefined roles).
 */

describe('a role that reaches a refused role only through SET ROLE', () => {
  jest.setTimeout(120_000);

  const password = randomPassword();
  const superuserRole = 'confera_test_set_superuser';
  /** [login role, how it reaches the refused role, kind of the check]. */
  const cases = [
    ['confera_test_set_a_system', 'confera_system', 'grant', 'application'],
    ['confera_test_set_a_files', 'pg_read_server_files', 'grant', 'application'],
    ['confera_test_set_a_super', superuserRole, 'grant', 'application'],
    ['confera_test_set_s_files', 'pg_execute_server_program', 'grant', 'system'],
    ['confera_test_set_a_noinherit', 'confera_system', 'noinherit', 'application'],
  ] as const;
  let superuser: Client;

  const drop = async (): Promise<void> => {
    const existing = await rows<{ rolname: string }>(
      superuser,
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'confera_test_set_%' ORDER BY rolname = $1",
      [superuserRole],
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
    await superuser.query(`CREATE ROLE ${superuserRole} NOLOGIN SUPERUSER`);
    for (const [role, refused, how, kind] of cases) {
      const runtime = kind === 'application' ? 'confera_app' : 'confera_system';
      if (how === 'noinherit') {
        // A role that inherits nothing: every membership is SET ROLE only.
        await superuser.query(
          `CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD ${pw} IN ROLE ${runtime}, ${refused}`,
        );
      } else {
        await superuser.query(`CREATE ROLE ${role} LOGIN PASSWORD ${pw} IN ROLE ${runtime}`);
        await superuser.query(`GRANT ${refused} TO ${role} WITH INHERIT FALSE, SET TRUE`);
      }
      await superuser.query(`GRANT CONNECT ON DATABASE ${testDatabase.name} TO ${role}`);
    }
  });

  afterAll(async () => {
    await drop();
    await superuser.end();
  });

  it.each(cases)(
    '%s, which may SET ROLE %s (%s), is refused as the %s role',
    async (role, refused, _how, kind) => {
      const client = createBaseClient(addressFor(testDatabase.applicationUrl, role, password), {
        poolSize: 1,
      });
      try {
        // The control: the role does not hold the rights of the refused role by inheritance.
        const inherited = await client.$queryRaw<{ usage: boolean }[]>`
        SELECT pg_has_role(current_user, ${refused}, 'USAGE') AS "usage"`;
        expect(inherited).toEqual([{ usage: false }]);
        const problems = roleProblems(kind, await describeRole(client));
        expect(problems.join(' ')).toContain(refused);
      } finally {
        await client.$disconnect();
      }
    },
  );
});
