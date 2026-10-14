import type { Client } from 'pg';
import { validProductionEnvironment } from '../../src/config/testing/valid-environment';
import { describeRole, roleProblems } from '../../src/platform/prisma/database-role';
import { createBaseClient } from '../../src/platform/prisma/tenant-client';
import { freePort, PRODUCTION_ENTRY, startApi } from '../support/api-process';
import { runNode } from '../support/run-node';
import {
  addressFor,
  connect,
  connectAsSuperuser,
  errorCode,
  randomPassword,
  rows,
  seedTwoOrganisations,
  SQLSTATE,
  testDatabase,
} from './support/database';

/**
 * The database roles of ADR-05 (M1-BE-02, M1-BE-03):
 *
 * - ST-65 (schema part): the application role cannot create or alter a table;
 * - ST-08: the system role cannot change the schema either, and the API refuses to
 *   start when its application role is a superuser, may bypass row-level security or is
 *   an owner.
 */

const EXIT_REFUSED = 77;

/** Statements that change the schema or go around the policies. None may succeed. */
const SCHEMA_CHANGES: readonly [name: string, sql: string][] = [
  ['CREATE TABLE', 'CREATE TABLE zz_new (id int)'],
  ['CREATE TABLE in a named schema', 'CREATE TABLE public.zz_new (id int)'],
  ['CREATE TEMPORARY TABLE', 'CREATE TEMPORARY TABLE zz_temp (id int)'],
  ['CREATE TABLE AS', 'CREATE TABLE zz_copy AS SELECT 1 AS id'],
  ['SELECT INTO', 'SELECT 1 AS id INTO zz_into'],
  ['ALTER TABLE ADD COLUMN', 'ALTER TABLE users ADD COLUMN zz_extra text'],
  ['ALTER TABLE DROP COLUMN', 'ALTER TABLE users DROP COLUMN display_name'],
  ['ALTER TABLE RENAME', 'ALTER TABLE users RENAME TO zz_users'],
  ['ALTER TABLE OWNER', 'ALTER TABLE users OWNER TO CURRENT_USER'],
  ['DROP TABLE', 'DROP TABLE user_roles'],
  ['TRUNCATE', 'TRUNCATE users CASCADE'],
  ['CREATE INDEX', 'CREATE INDEX zz_index ON users (display_name)'],
  ['CREATE VIEW', 'CREATE VIEW zz_view AS SELECT 1 AS id'],
  ['CREATE SCHEMA', 'CREATE SCHEMA zz_schema'],
  ['CREATE FUNCTION', "CREATE FUNCTION zz_function() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
  ['CREATE EXTENSION', 'CREATE EXTENSION IF NOT EXISTS pg_trgm'],
  [
    'CREATE TRIGGER',
    'CREATE TRIGGER zz_trigger BEFORE INSERT ON users EXECUTE FUNCTION suppress_redundant_updates_trigger()',
  ],
  ['disable row-level security', 'ALTER TABLE users DISABLE ROW LEVEL SECURITY'],
  ['stop forcing row-level security', 'ALTER TABLE users NO FORCE ROW LEVEL SECURITY'],
  ['DROP POLICY', 'DROP POLICY tenant_isolation ON users'],
  ['CREATE POLICY', 'CREATE POLICY zz_open ON users USING (true)'],
  ['ALTER POLICY', 'ALTER POLICY tenant_isolation ON users USING (true)'],
  ['GRANT on a table it has no right on', 'GRANT SELECT ON _prisma_migrations TO CURRENT_USER'],
  ['become the owner', 'SET ROLE confera_owner'],
  ['become the superuser', 'SET ROLE postgres'],
  ['SET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION confera_owner'],
  ['give itself BYPASSRLS', 'ALTER ROLE CURRENT_USER BYPASSRLS'],
  ['CREATE ROLE', 'CREATE ROLE zz_role'],
  ['read the migration history', 'SELECT * FROM _prisma_migrations'],
];

describe('database roles', () => {
  jest.setTimeout(180_000);

  let superuser: Client;

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
    await seedTwoOrganisations(superuser);
  });

  afterAll(async () => {
    await superuser.end();
  });

  describe.each([
    ['application', () => testDatabase.applicationUrl, 'confera_app'],
    ['system', () => testDatabase.systemUrl, 'confera_system'],
  ])('the %s role cannot change the schema (ST-65, ST-08)', (_kind, address, expectedName) => {
    let client: Client;

    beforeAll(async () => {
      client = await connect(address());
    });

    afterAll(async () => {
      await client.end();
    });

    it('is the role it should be', async () => {
      const [who] = await rows<{ current_user: string }>(client, 'SELECT current_user');
      expect(who?.current_user).toBe(expectedName);
    });

    it.each(SCHEMA_CHANGES)('%s is refused', async (_name, sql) => {
      const code = await errorCode(() => client.query(sql));
      expect(code).toBe(SQLSTATE.insufficientPrivilege);
    });

    it('left the schema as the migrations made it', async () => {
      const tables = await rows<{ tablename: string }>(
        superuser,
        "SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1",
      );
      expect(tables.map((t) => t.tablename)).toEqual([
        '_prisma_migrations',
        'organisations',
        'user_roles',
        'users',
      ]);
      const [users] = await rows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        superuser,
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'users'",
      );
      expect(users).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });

  describe('the application role', () => {
    it('has a statement timeout, so a runaway statement is stopped', async () => {
      const client = await connect(testDatabase.applicationUrl);
      try {
        const [timeout] = await rows<{ statement_timeout: string }>(
          client,
          'SHOW statement_timeout',
        );
        expect(timeout?.statement_timeout).toBe('15s');
        await client.query("SET statement_timeout = '200ms'");
        expect(await errorCode(() => client.query('SELECT pg_sleep(2)'))).toBe('57014');
      } finally {
        await client.end();
      }
    });

    it('is what the start-up check accepts', async () => {
      const client = createBaseClient(testDatabase.applicationUrl, { poolSize: 1 });
      try {
        const role = await describeRole(client);
        expect(role).toEqual({
          name: 'confera_app',
          superuser: false,
          bypassRls: false,
          createDb: false,
          createRole: false,
          replication: false,
          createSchema: false,
          createTemp: false,
          createInSchema: false,
          owner: false,
          memberOfSuperuser: [],
          memberOfBypassRls: [],
          memberOfCreateRole: [],
        });
        expect(roleProblems('application', role)).toEqual([]);
      } finally {
        await client.$disconnect();
      }
    });
  });

  describe('the system role', () => {
    let system: Client;

    beforeAll(async () => {
      system = await connect(testDatabase.systemUrl);
    });

    afterAll(async () => {
      await system.end();
    });

    it('may bypass the policies and is otherwise as limited as the application role', async () => {
      const client = createBaseClient(testDatabase.systemUrl, { poolSize: 1 });
      try {
        const role = await describeRole(client);
        expect(role).toEqual(
          expect.objectContaining({
            name: 'confera_system',
            bypassRls: true,
            superuser: false,
            owner: false,
          }),
        );
        expect(roleProblems('system', role)).toEqual([]);
        // The same attributes on the application role would stop the start.
        expect(roleProblems('application', role)).toEqual([
          'may bypass row-level security (BYPASSRLS)',
        ]);
      } finally {
        await client.$disconnect();
      }
    });

    it('reads the three columns of a resolver, across organisations', async () => {
      const found = await rows(system, 'SELECT id, organisation_id, email FROM users');
      expect(found).toHaveLength(5);
    });

    it.each([
      ['the password hash', 'SELECT password_hash FROM users'],
      ['every column', 'SELECT * FROM users'],
      ['the display name', 'SELECT display_name FROM users'],
      ['organisations', 'SELECT id FROM organisations'],
      ['roles of users', 'SELECT * FROM user_roles'],
      [
        'an insert',
        "INSERT INTO users (organisation_id, email, display_name) SELECT organisation_id, 'x@example.test', 'X' FROM users LIMIT 1",
      ],
      ['an update', "UPDATE users SET email = 'x@example.test'"],
      ['a delete', 'DELETE FROM users'],
    ])('is refused %s', async (_name, sql) => {
      expect(await errorCode(() => system.query(sql))).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  describe('the API refuses to start on a role that is too powerful (ST-08)', () => {
    const password = randomPassword();
    const roles = {
      superuser: 'confera_test_superuser',
      bypass: 'confera_test_bypass',
      ownerMember: 'confera_test_owner_member',
      creator: 'confera_test_creator',
      temp: 'confera_test_temp',
      createDb: 'confera_test_createdb',
      plain: 'confera_test_plain',
    } as const;

    const drop = async (): Promise<void> => {
      for (const role of Object.values(roles)) {
        const exists = await rows(superuser, 'SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.length > 0) {
          await superuser.query(`REVOKE ALL ON DATABASE ${testDatabase.name} FROM ${role}`);
          await superuser.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
          await superuser.query(`DROP ROLE ${role}`);
        }
      }
    };

    beforeAll(async () => {
      await drop();
      const pw = superuser.escapeLiteral(password);
      // Each role is the application role (member of confera_app, so it has its grants)
      // plus exactly one thing the application role must not have.
      await superuser.query(`CREATE ROLE ${roles.superuser} LOGIN SUPERUSER PASSWORD ${pw}`);
      await superuser.query(
        `CREATE ROLE ${roles.bypass} LOGIN BYPASSRLS PASSWORD ${pw} IN ROLE confera_app`,
      );
      await superuser.query(
        `CREATE ROLE ${roles.ownerMember} LOGIN PASSWORD ${pw} IN ROLE confera_app, confera_owner`,
      );
      await superuser.query(
        `CREATE ROLE ${roles.creator} LOGIN PASSWORD ${pw} IN ROLE confera_app`,
      );
      await superuser.query(`GRANT CREATE ON SCHEMA public TO ${roles.creator}`);
      await superuser.query(`CREATE ROLE ${roles.temp} LOGIN PASSWORD ${pw} IN ROLE confera_app`);
      await superuser.query(`GRANT TEMPORARY ON DATABASE ${testDatabase.name} TO ${roles.temp}`);
      await superuser.query(
        `CREATE ROLE ${roles.createDb} LOGIN CREATEDB PASSWORD ${pw} IN ROLE confera_app`,
      );
      await superuser.query(`CREATE ROLE ${roles.plain} LOGIN PASSWORD ${pw} IN ROLE confera_app`);
      for (const role of Object.values(roles)) {
        await superuser.query(`GRANT CONNECT ON DATABASE ${testDatabase.name} TO ${role}`);
      }
    });

    afterAll(drop);

    const environment = (overrides: Record<string, string>) => ({
      ...validProductionEnvironment(),
      DATABASE_URL: testDatabase.applicationUrl,
      SYSTEM_DATABASE_URL: testDatabase.systemUrl,
      ...overrides,
    });

    const start = async (overrides: Record<string, string>) => {
      const port = String(await freePort());
      return runNode([PRODUCTION_ENTRY], {
        env: { ...environment(overrides), PORT: port, LISTEN_HOST: '127.0.0.1' },
        timeoutMs: 30_000,
      });
    };

    const as = (role: string) => addressFor(testDatabase.applicationUrl, role, password);

    it.each([
      ['a superuser', roles.superuser, 'is a superuser'],
      ['a role that may bypass row-level security', roles.bypass, 'may bypass row-level security'],
      ['a member of the owner role', roles.ownerMember, 'owns the database, the schema or a table'],
      ['a role that may create tables', roles.creator, 'may create tables or schemas'],
      ['a role that may create temporary tables', roles.temp, 'may create temporary tables'],
      ['a role that may create databases', roles.createDb, 'may create databases or roles'],
    ])('as %s', async (_name, role, reason) => {
      const result = await start({ DATABASE_URL: as(role) });
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: EXIT_REFUSED,
        stderr: expect.stringContaining('The application database role of DATABASE_URL'),
      });
      expect(result.stderr).toContain(reason);
      expect(result.stderr).toContain('refuses to start');
      expect(result.output).not.toContain('api.started');
      expect(result.output).not.toContain(password);
    });

    it('as the owner role itself', async () => {
      const result = await start({ DATABASE_URL: testDatabase.ownerUrl });
      expect(result.exitCode).toBe(EXIT_REFUSED);
      expect(result.stderr).toContain('owns the database, the schema or a table');
      expect(result.output).not.toContain('api.started');
    });

    it('when the system role is a superuser', async () => {
      const result = await start({ SYSTEM_DATABASE_URL: as(roles.superuser) });
      expect(result.exitCode).toBe(EXIT_REFUSED);
      expect(result.stderr).toContain(
        'The system database role of SYSTEM_DATABASE_URL is a superuser',
      );
    });

    it('when the system role is the owner', async () => {
      const result = await start({ SYSTEM_DATABASE_URL: testDatabase.ownerUrl });
      expect(result.exitCode).toBe(EXIT_REFUSED);
      expect(result.stderr).toContain('The system database role of SYSTEM_DATABASE_URL owns');
    });

    it('when both addresses use the same role', async () => {
      const result = await start({ SYSTEM_DATABASE_URL: testDatabase.applicationUrl });
      expect(result.exitCode).toBe(EXIT_REFUSED);
      expect(result.stderr).toContain('use the same database role');
    });

    it.each([
      [
        'a wrong password',
        () => addressFor(testDatabase.applicationUrl, 'confera_app', `${password}-wrong`),
      ],
      [
        'a role that does not exist',
        () => addressFor(testDatabase.applicationUrl, 'confera_nobody', password),
      ],
      [
        'a database that does not exist',
        () => testDatabase.applicationUrl.replace(testDatabase.name, 'confera_missing_test'),
      ],
      [
        'a server that does not answer',
        () => 'postgresql://confera_app:invented-unreachable@127.0.0.1:1/confera',
      ],
    ])('when the database cannot be reached: %s', async (_name, address) => {
      const result = await start({ DATABASE_URL: address() });
      expect(result.exitCode).toBe(EXIT_REFUSED);
      expect(result.stderr).toContain('The database cannot be reached with DATABASE_URL');
      expect(result.output).not.toContain('api.started');
      // Neither the terminal nor the log shows a password.
      expect(result.output).not.toContain(password);
      expect(result.output).not.toContain('invented-unreachable');
    });

    it('starts with a role that has nothing but the grants of the application role', async () => {
      const api = await startApi(PRODUCTION_ENTRY, environment({ DATABASE_URL: as(roles.plain) }));
      try {
        expect((await api.request('/health/ready')).status).toBe(200);
        expect(api.output()).toContain('database.roles.checked');
      } finally {
        await api.stop();
      }
    });
  });
});
