import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { SystemResolvers } from '../../src/platform/prisma/system/resolvers';
import { TenantDatabase } from '../../src/platform/prisma/tenant-database';
import { NoOrganisationError, TenantContext } from '../../src/platform/tenancy/tenant-context';
import { repoRoot } from '../support/run-node';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connect, connectAsOwner, e2eDatabase, rows } from './support/e2e-database';
import {
  assertInvented,
  buildOrganisation,
  buildUser,
  Factories,
  INSTANCE_TABLES,
  INVENTED_DOMAIN,
  type InventedOrganisation,
  type InventedUser,
  TENANT_TABLES,
} from './support/factories';

/**
 * The end-to-end harness is what it says it is (M1-QA-01, ADR-24):
 *
 * - the schema of its database came from `prisma migrate deploy`;
 * - the application under test is the real one and connects as the application role;
 * - what a test reads through the application went through row-level security;
 * - the factories invent people on example.test and cannot write across organisations.
 *
 * Every later e2e test stands on these facts, so they are tested themselves.
 */
describe('the end-to-end harness', () => {
  jest.setTimeout(120_000);

  let owner: Client;
  let factories: Factories;
  let e2e: E2eApp;
  let context: TenantContext;
  let database: TenantDatabase;
  let a: { organisation: InventedOrganisation; users: InventedUser[] };
  let b: { organisation: InventedOrganisation; users: InventedUser[] };

  beforeAll(async () => {
    owner = await connectAsOwner();
    factories = new Factories(owner);
    await factories.reset();
    a = await factories.organisationWithPeople(2);
    b = await factories.organisationWithPeople(1);
    e2e = await startE2eApp();
    context = e2e.app.get(TenantContext);
    database = e2e.app.get(TenantDatabase);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  describe('the database', () => {
    it('has its schema from prisma migrate deploy: every committed migration, applied once', async () => {
      const committed = readdirSync(join(repoRoot, 'prisma', 'migrations'), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(committed.length).toBeGreaterThan(0);

      const applied = await rows<{
        migration_name: string;
        finished: boolean;
        rolled_back: boolean;
      }>(
        owner,
        `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
         FROM _prisma_migrations ORDER BY migration_name`,
      );
      expect(applied).toEqual(
        committed.map((name) => ({ migration_name: name, finished: true, rolled_back: false })),
      );
    });

    it('is the database of this tier, not the development one', async () => {
      const [current] = await rows<{ name: string }>(owner, 'SELECT current_database() AS name');
      expect(current?.name).toBe(e2eDatabase.name);
      expect(e2eDatabase.name).toMatch(/^confera_[a-z0-9_]*test$/);
      expect(e2eDatabase.name).not.toBe('confera');
    });

    it('runs on PostgreSQL 18', async () => {
      const [version] = await rows<{ server_version: string }>(owner, 'SHOW server_version');
      expect(version?.server_version).toMatch(/^18\./);
    });
  });

  describe('the application under test', () => {
    it('started for real: its start-up role check ran against the database', () => {
      expect(e2e.logs()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            msg: 'database.roles.checked',
            application: 'confera_app',
            system: 'confera_system',
          }),
        ]),
      );
    });

    it('connects as the application role: no superuser, no bypass, owner of nothing', async () => {
      const [role] = await context.run(
        a.organisation.id,
        () =>
          database.db.$queryRaw<
            { name: string; superuser: boolean; bypass: boolean; owns: boolean }[]
          >`
          SELECT current_user::text AS "name", r.rolsuper AS "superuser", r.rolbypassrls AS "bypass",
                 EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'public' AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS "owns"
          FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(role).toEqual({ name: 'confera_app', superuser: false, bypass: false, owns: false });
    });

    it('runs with the configuration of a server', () => {
      expect(e2e.config.stage).toBe('prod');
      expect(e2e.config.devTools).toEqual({ apiDocs: false, logQueries: false });
    });
  });

  describe('row-level security is in force for everything a test reads through the application', () => {
    it('each organisation reads exactly its own people', async () => {
      const ofA = await context.run(a.organisation.id, () => database.db.user.findMany());
      const ofB = await context.run(b.organisation.id, () => database.db.user.findMany());
      expect(ofA.map((user) => user.email).sort()).toEqual(a.users.map((u) => u.email).sort());
      expect(ofB.map((user) => user.email).sort()).toEqual(b.users.map((u) => u.email).sort());
    });

    it('a person of the other organisation is not found by id or by email', async () => {
      const stranger = b.users[0]!;
      const found = await context.run(a.organisation.id, async () => [
        await database.db.user.findUnique({ where: { id: stranger.id } }),
        await database.db.user.findUnique({ where: { email: stranger.email } }),
        await database.db.user.count({ where: { organisationId: b.organisation.id } }),
      ]);
      expect(found).toEqual([null, null, 0]);
    });

    it('without an organisation nothing is read, and nothing reaches the database', async () => {
      await expect(database.db.user.findMany()).rejects.toThrow(NoOrganisationError);
    });

    it('a plain connection as the application role, with no organisation, sees no row', async () => {
      const plain = await connect(e2eDatabase.applicationUrl);
      try {
        expect(await rows(plain, 'SELECT * FROM users')).toEqual([]);
        expect(await rows(plain, 'SELECT * FROM organisations')).toEqual([]);
        expect(await rows(plain, 'SELECT * FROM user_roles')).toEqual([]);
      } finally {
        await plain.end();
      }
    });

    it('the resolver of sign-in finds a factory person and returns the two ids', async () => {
      const person = a.users[0]!;
      const resolved = await e2e.app.get(SystemResolvers).userByEmail(person.email);
      expect(resolved).toEqual({ organisationId: a.organisation.id, userId: person.id });
    });
  });

  describe('the factories', () => {
    it('invent people on example.test, each with an address of their own', () => {
      const organisation = buildOrganisation();
      const people = Array.from({ length: 50 }, () => buildUser(organisation));
      for (const person of people) {
        expect(person.email).toMatch(/^[a-z0-9.-]+@[a-z0-9.-]+\.example\.test$/);
        expect(person.organisationId).toBe(organisation.id);
      }
      expect(new Set(people.map((person) => person.email)).size).toBe(people.length);
      expect(new Set(people.map((person) => person.id)).size).toBe(people.length);
    });

    it('give them names with š č ć ž đ, which come back from the database as they went in', async () => {
      const names = [...a.users, ...b.users].map((user) => user.displayName);
      expect(names.join(' ')).toMatch(/[šđčćžŠĐČĆŽ]/);
      const stored = await context.run(a.organisation.id, () =>
        database.db.user.findMany({ orderBy: { email: 'asc' } }),
      );
      expect(stored.map((user) => user.displayName)).toEqual(
        [...a.users].sort((x, y) => (x.email < y.email ? -1 : 1)).map((user) => user.displayName),
      );
    });

    it.each([
      'someone@gmail.com',
      'someone@example.com',
      'someone@example.test.evil.example',
      'someone@notexample.test',
      'someone',
    ])('refuse an address that is not invented: %s', (email) => {
      expect(() => {
        assertInvented(email);
      }).toThrow(/must live on example\.test/);
      expect(() => buildUser(buildOrganisation(), { email })).toThrow(/must live on example\.test/);
    });

    it(`accept only ${INVENTED_DOMAIN} and names under it`, () => {
      expect(() => {
        assertInvented('a@example.test');
        assertInvented('a@b.example.test');
        assertInvented('a@B.EXAMPLE.TEST');
      }).not.toThrow();
    });

    it('write through the write check too: a row for another organisation is refused', async () => {
      const intruder = buildUser(b.organisation);
      await owner.query('BEGIN');
      let code: string | undefined;
      try {
        await owner.query("SELECT set_config('app.org_id', $1, true)", [a.organisation.id]);
        await owner.query(
          'INSERT INTO users (id, organisation_id, email, display_name) VALUES ($1, $2, $3, $4)',
          [intruder.id, intruder.organisationId, intruder.email, intruder.displayName],
        );
      } catch (error) {
        code = (error as { code?: string }).code;
      } finally {
        await owner.query('ROLLBACK');
      }
      expect(code).toBe('42501');
    });

    it('reset knows every tenant and instance table of the schema', async () => {
      const tables = await rows<{ tablename: string }>(
        owner,
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1",
      );
      // The reference tables are seeded by migration and never emptied.
      const reference = ['roles', 'role_permissions'];
      expect(tables.map((table) => table.tablename)).toEqual(
        [...TENANT_TABLES, ...INSTANCE_TABLES, ...reference].sort(),
      );
    });

    // The last test of this file: it empties the tables the tests above read.
    it('reset empties the tenant tables and leaves the schema and the migration history', async () => {
      const system = await connect(e2eDatabase.systemUrl);
      try {
        const count = async (): Promise<number> =>
          Number((await rows<{ n: string }>(system, 'SELECT count(id) AS n FROM users'))[0]?.n);
        expect(await count()).toBe(a.users.length + b.users.length);

        await factories.reset();

        expect(await count()).toBe(0);
        for (const { organisation } of [a, b]) {
          const left = await context.run(organisation.id, async () => [
            await database.db.organisation.count(),
            await database.db.userRole.count(),
          ]);
          expect(left).toEqual([0, 0]);
        }
        const [history] = await rows<{ n: string }>(
          owner,
          'SELECT count(*) AS n FROM _prisma_migrations',
        );
        expect(Number(history?.n)).toBeGreaterThan(0);
      } finally {
        await system.end();
      }
    });
  });
});
