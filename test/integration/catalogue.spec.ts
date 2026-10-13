import type { Client } from 'pg';
import {
  catalogueProblems,
  REVIEWED_GLOBAL_TABLES,
  SYSTEM_ROLE_COLUMNS,
} from './support/catalogue';
import { connectAsSuperuser, rows } from './support/database';

/**
 * ST-07, permanent: the catalogue of the migrated database obeys the tenancy rules.
 * Every later migration is checked by this test without being named in it.
 */
describe('catalogue of the migrated database (ST-07)', () => {
  jest.setTimeout(120_000);

  let superuser: Client;

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
  });

  afterAll(async () => {
    await superuser.end();
  });

  /** Runs statements, collects what the check says, and undoes everything. */
  async function problemsAfter(...statements: string[]): Promise<string[]> {
    await superuser.query('BEGIN');
    try {
      for (const statement of statements) {
        await superuser.query(statement);
      }
      return await catalogueProblems(superuser);
    } finally {
      await superuser.query('ROLLBACK');
    }
  }

  it('has no problem as the migrations leave it', async () => {
    expect(await catalogueProblems(superuser)).toEqual([]);
  });

  it('was created by prisma migrate deploy', async () => {
    const applied = await rows<{ migration_name: string; finished: boolean }>(
      superuser,
      'SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY 1',
    );
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((migration) => migration.finished)).toBe(true);
  });

  it('every table is a tenant table or on the reviewed list, with a reason', async () => {
    const tables = await rows<{ tablename: string; has_column: boolean }>(
      superuser,
      `SELECT t.tablename,
              EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_schema = t.schemaname AND c.table_name = t.tablename
                        AND c.column_name = 'organisation_id') AS has_column
       FROM pg_tables t WHERE t.schemaname = 'public'`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(4);
    for (const table of tables) {
      expect(table.has_column || table.tablename in REVIEWED_GLOBAL_TABLES).toBe(true);
    }
    for (const reason of Object.values(REVIEWED_GLOBAL_TABLES)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('the system role reads exactly the reviewed columns', async () => {
    const granted = await rows<{ table_name: string; column_name: string }>(
      superuser,
      "SELECT table_name, column_name FROM information_schema.column_privileges WHERE grantee = 'confera_system' AND table_schema = 'public' ORDER BY 1, 2",
    );
    const byTable: Record<string, string[]> = {};
    for (const { table_name, column_name } of granted) {
      (byTable[table_name] ??= []).push(column_name);
    }
    expect(byTable).toEqual(SYSTEM_ROLE_COLUMNS);
  });

  describe('the check finds what it is there for', () => {
    it.each<[string, string[], RegExp]>([
      [
        'a table without the organisation column',
        ['CREATE TABLE zz_plain (id uuid PRIMARY KEY, note text)'],
        /zz_plain: no uuid column organisation_id/,
      ],
      [
        'a tenant table without row-level security',
        [
          'CREATE TABLE zz_open (id uuid PRIMARY KEY, organisation_id uuid NOT NULL, UNIQUE (organisation_id, id))',
        ],
        /zz_open: row-level security is not enabled/,
      ],
      [
        'row-level security that is enabled but not forced',
        ['ALTER TABLE users NO FORCE ROW LEVEL SECURITY'],
        /users: row-level security is not forced/,
      ],
      [
        'row-level security without any policy',
        [
          'CREATE TABLE zz_nopolicy (id uuid PRIMARY KEY, organisation_id uuid NOT NULL, UNIQUE (organisation_id, id))',
          'ALTER TABLE zz_nopolicy ENABLE ROW LEVEL SECURITY',
          'ALTER TABLE zz_nopolicy FORCE ROW LEVEL SECURITY',
        ],
        /zz_nopolicy: no policy for SELECT/,
      ],
      [
        'a policy for reading only',
        [
          'DROP POLICY tenant_isolation ON users',
          "CREATE POLICY tenant_isolation ON users FOR SELECT USING (organisation_id = NULLIF(current_setting('app.org_id', true), '')::uuid)",
        ],
        /users: no policy for INSERT/,
      ],
      [
        'a policy without the write check',
        [
          'DROP POLICY tenant_isolation ON user_roles',
          "CREATE POLICY read_side ON user_roles FOR SELECT USING (organisation_id = NULLIF(current_setting('app.org_id', true), '')::uuid)",
          'CREATE POLICY write_side ON user_roles FOR INSERT WITH CHECK (true)',
          "CREATE POLICY change_side ON user_roles FOR UPDATE USING (organisation_id = NULLIF(current_setting('app.org_id', true), '')::uuid)",
          "CREATE POLICY delete_side ON user_roles FOR DELETE USING (organisation_id = NULLIF(current_setting('app.org_id', true), '')::uuid)",
        ],
        /user_roles: policy write_side WITH CHECK does not compare organisation_id/,
      ],
      [
        'a policy that lets everything through',
        [
          'DROP POLICY tenant_isolation ON users',
          'CREATE POLICY tenant_isolation ON users USING (true) WITH CHECK (true)',
        ],
        /users: policy tenant_isolation USING does not compare organisation_id/,
      ],
      [
        'a policy that reads the setting in the form that fails when it is missing',
        [
          'DROP POLICY tenant_isolation ON users',
          "CREATE POLICY tenant_isolation ON users USING (organisation_id = current_setting('app.org_id')::uuid) WITH CHECK (organisation_id = current_setting('app.org_id')::uuid)",
        ],
        /users: policy tenant_isolation USING does not compare organisation_id with the missing-ok setting/,
      ],
      [
        'an organisation column that may be empty',
        [
          'ALTER TABLE user_roles DROP CONSTRAINT user_roles_pkey',
          'ALTER TABLE user_roles ALTER COLUMN organisation_id DROP NOT NULL',
        ],
        /user_roles: organisation_id may be NULL/,
      ],
      [
        'a foreign key to a tenant table that is not composite',
        [
          'CREATE TABLE zz_child (id uuid PRIMARY KEY, organisation_id uuid NOT NULL, user_id uuid REFERENCES users (id), UNIQUE (organisation_id, id))',
          'ALTER TABLE zz_child ENABLE ROW LEVEL SECURITY',
          'ALTER TABLE zz_child FORCE ROW LEVEL SECURITY',
          "CREATE POLICY tenant_isolation ON zz_child USING (organisation_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (organisation_id = NULLIF(current_setting('app.org_id', true), '')::uuid)",
        ],
        /zz_child: foreign key zz_child_user_id_fkey to users is not composite on organisation_id/,
      ],
      [
        'a tenant table without the unique key for composite foreign keys',
        ['DROP INDEX users_organisation_id_id_key CASCADE'],
        /users: no unique key on \(organisation_id, id\)/,
      ],
      [
        'a security-definer function',
        [
          "CREATE FUNCTION zz_definer() RETURNS SETOF users LANGUAGE sql SECURITY DEFINER AS 'SELECT * FROM users'",
        ],
        /function zz_definer\(\) is SECURITY DEFINER/,
      ],
      [
        'a view that runs with the rights of its owner',
        ['CREATE VIEW zz_all_users AS SELECT * FROM users'],
        /view zz_all_users does not run with the rights of the caller/,
      ],
      [
        'a table grant to the system role',
        ['GRANT SELECT ON user_roles TO confera_system'],
        /user_roles: the system role has SELECT on the whole table/,
      ],
      [
        'a column grant to the system role that is not on the list',
        ['GRANT SELECT (password_hash) ON users TO confera_system'],
        /users\.password_hash: the system role has SELECT/,
      ],
      [
        'TRUNCATE for the application role',
        ['GRANT TRUNCATE ON users TO confera_app'],
        /users: the application role has TRUNCATE/,
      ],
      [
        'a grant to PUBLIC',
        ['GRANT SELECT ON organisations TO PUBLIC'],
        /organisations: SELECT is granted to PUBLIC/,
      ],
      [
        'a grant on the migration history',
        ['GRANT SELECT ON _prisma_migrations TO confera_app'],
        /_prisma_migrations: confera_app has SELECT on an owner-only table/,
      ],
      [
        'the application role as a member of the owner role',
        ['GRANT confera_owner TO confera_app'],
        /confera_app is a member of confera_owner/,
      ],
    ])('%s', async (_name, statements, expected) => {
      const problems = await problemsAfter(...statements);
      expect(problems.join('\n')).toMatch(expected);
    });

    it('and the database is unchanged afterwards', async () => {
      expect(await catalogueProblems(superuser)).toEqual([]);
    });
  });
});
