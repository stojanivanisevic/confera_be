import type { Client } from 'pg';
import { validProductionEnvironment } from '../../src/config/testing/valid-environment';
import { describeRole, roleProblems } from '../../src/platform/prisma/database-role';
import { createBaseClient } from '../../src/platform/prisma/tenant-client';
import { API_START_LIMIT_MS, freePort, PRODUCTION_ENTRY } from '../support/api-process';
import { runNode } from '../support/run-node';
import {
  addressFor,
  connect,
  connectAsSuperuser,
  randomPassword,
  rows,
  seedTwoOrganisations,
  testDatabase,
} from './support/database';

/**
 * Edge cases of the start-up role check found by the edge-case hunter (M1-REV-01).
 *
 * ADR-05: "At every start the API checks that its role is not superuser, not bypass and
 * not an owner, and refuses to start otherwise", because "a restore or a mistake can turn
 * the application role into one of them" (database-role.ts). The check reads the
 * ATTRIBUTES of the role it logs in as, and for ownership it also follows membership
 * ("is, or is a member of, the role that owns ..."). For superuser and BYPASSRLS it does
 * not follow membership. But a member of a role may become that role with one statement,
 * `SET ROLE`, and then the attributes of that role apply: row-level security is gone for
 * the rest of the session, and the session is a pooled connection.
 *
 * So `GRANT confera_system TO confera_app` (or a grant of any superuser role), which is
 * exactly the kind of mistake the check exists for, leaves an application role that the
 * check accepts and that reads every organisation.
 */

const EXIT_REFUSED = 77;

describe('edge cases of the start-up role check (M1-REV-01)', () => {
  jest.setTimeout(180_000);

  const password = randomPassword();
  const roles = {
    /** NOLOGIN, SUPERUSER: stands for `postgres` or any other superuser role of a server. */
    superuser: 'confera_test_edge_superuser',
    /** The application role plus membership in the system role, which may bypass the policies. */
    appInSystem: 'confera_test_edge_app_in_system',
    /** The application role plus membership in a superuser role. */
    appInSuperuser: 'confera_test_edge_app_in_superuser',
    /** The system role plus membership in a superuser role. */
    systemInSuperuser: 'confera_test_edge_system_in_superuser',
  } as const;

  let superuser: Client;

  const drop = async (): Promise<void> => {
    for (const role of Object.values(roles)) {
      const exists = await rows(superuser, 'SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.length > 0) {
        await superuser.query(`REVOKE ALL ON DATABASE ${testDatabase.name} FROM ${role}`);
        await superuser.query(`DROP ROLE ${role}`);
      }
    }
  };

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
    await seedTwoOrganisations(superuser);
    await drop();
    const pw = superuser.escapeLiteral(password);
    await superuser.query(`CREATE ROLE ${roles.superuser} NOLOGIN SUPERUSER`);
    await superuser.query(
      `CREATE ROLE ${roles.appInSystem} LOGIN PASSWORD ${pw} IN ROLE confera_app, confera_system`,
    );
    await superuser.query(
      `CREATE ROLE ${roles.appInSuperuser} LOGIN PASSWORD ${pw} IN ROLE confera_app, ${roles.superuser}`,
    );
    await superuser.query(
      `CREATE ROLE ${roles.systemInSuperuser} LOGIN PASSWORD ${pw} IN ROLE confera_system, ${roles.superuser}`,
    );
    for (const role of [roles.appInSystem, roles.appInSuperuser, roles.systemInSuperuser]) {
      await superuser.query(`GRANT CONNECT ON DATABASE ${testDatabase.name} TO ${role}`);
    }
  });

  afterAll(async () => {
    await drop();
    await superuser.end();
  });

  const as = (role: string) => addressFor(testDatabase.applicationUrl, role, password);

  it('why it matters: such a role leaves row-level security with one statement and reads every organisation', async () => {
    const client = await connect(as(roles.appInSystem));
    try {
      // As the application role: no organisation set, no rows (the backstop holds) ...
      expect(await rows(client, 'SELECT id FROM users')).toHaveLength(0);
      // ... until it becomes the role it is a member of.
      await client.query('SET ROLE confera_system');
      expect(await rows(client, 'SELECT id, organisation_id, email FROM users')).toHaveLength(5);
    } finally {
      await client.end();
    }
  });

  it.each([
    ['a member of the system role, which may bypass row-level security', roles.appInSystem],
    ['a member of a superuser role', roles.appInSuperuser],
  ])(
    'the check finds a problem in an application role that is %s (ADR-05, ST-08)',
    async (_what, role) => {
      const client = createBaseClient(as(role), { poolSize: 1 });
      try {
        const described = await describeRole(client);
        expect(roleProblems('application', described)).not.toEqual([]);
      } finally {
        await client.$disconnect();
      }
    },
  );

  it('the check finds a problem in a system role that is a member of a superuser role (ADR-05, ST-08)', async () => {
    const client = createBaseClient(as(roles.systemInSuperuser), { poolSize: 1 });
    try {
      expect(roleProblems('system', await describeRole(client))).not.toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it('the built API refuses to start when its application role is a member of the system role', async () => {
    const port = String(await freePort());
    const result = await runNode([PRODUCTION_ENTRY], {
      env: {
        ...validProductionEnvironment(),
        DATABASE_URL: as(roles.appInSystem),
        SYSTEM_DATABASE_URL: testDatabase.systemUrl,
        PORT: port,
        LISTEN_HOST: '127.0.0.1',
      },
      timeoutMs: API_START_LIMIT_MS,
    });
    expect({ exitCode: result.exitCode, timedOut: result.timedOut }).toEqual({
      exitCode: EXIT_REFUSED,
      timedOut: false,
    });
    expect(result.stderr).toContain('The application database role of DATABASE_URL');
    expect(result.output).not.toContain('api.started');
    expect(result.output).not.toContain(password);
  });
});
