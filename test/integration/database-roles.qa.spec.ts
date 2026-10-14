import type { Client } from 'pg';
import { describeRole, roleProblems } from '../../src/platform/prisma/database-role';
import { createBaseClient } from '../../src/platform/prisma/tenant-client';
import {
  addressFor,
  connectAsSuperuser,
  randomPassword,
  rows,
  seedTwoOrganisations,
  testDatabase,
} from './support/database';

/**
 * The start-up role check after E1 (verification of the edge-case round, test engineer).
 *
 * The check now refuses a role that reaches, through any chain of memberships, a role that
 * is a superuser, may bypass row-level security, or may create roles or databases. It does
 * not look at the predefined roles that give a role the server's files and programs:
 *
 *   pg_read_server_files       read any file the server can read, the data files included
 *   pg_write_server_files      write any file the server can write
 *   pg_execute_server_program  run any program as the operating-system user of the server
 *
 * PostgreSQL documents these three as able to gain superuser-level access (documentation,
 * "Predefined Roles"), so for the check they belong with the superuser roles: neither the
 * application role nor the system role may reach one of them.
 */

describe('the start-up role check and the roles of the server files (ADR-05, ST-08)', () => {
  jest.setTimeout(180_000);

  const password = randomPassword();
  const PREDEFINED = ['pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'];
  const roles = {
    pg_read_server_files: 'confera_test_qa_app_read_files',
    pg_write_server_files: 'confera_test_qa_app_write_files',
    pg_execute_server_program: 'confera_test_qa_app_run_programs',
    system: 'confera_test_qa_system_run_programs',
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
    for (const predefined of PREDEFINED) {
      const role = roles[predefined as keyof typeof roles];
      await superuser.query(
        `CREATE ROLE ${role} LOGIN PASSWORD ${pw} IN ROLE confera_app, ${predefined}`,
      );
      await superuser.query(`GRANT CONNECT ON DATABASE ${testDatabase.name} TO ${role}`);
    }
    await superuser.query(
      `CREATE ROLE ${roles.system} LOGIN PASSWORD ${pw} IN ROLE confera_system, pg_execute_server_program`,
    );
    await superuser.query(`GRANT CONNECT ON DATABASE ${testDatabase.name} TO ${roles.system}`);
  });

  afterAll(async () => {
    await drop();
    await superuser.end();
  });

  const as = (role: string) => addressFor(testDatabase.applicationUrl, role, password);

  it.each(PREDEFINED)(
    'the check finds a problem in an application role that is a member of %s',
    async (predefined) => {
      const client = createBaseClient(as(roles[predefined as keyof typeof roles]), {
        poolSize: 1,
      });
      try {
        expect(roleProblems('application', await describeRole(client))).not.toEqual([]);
      } finally {
        await client.$disconnect();
      }
    },
  );

  it('the check finds a problem in a system role that is a member of pg_execute_server_program', async () => {
    const client = createBaseClient(as(roles.system), { poolSize: 1 });
    try {
      expect(roleProblems('system', await describeRole(client))).not.toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
