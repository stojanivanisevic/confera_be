import type { Client } from 'pg';
import {
  createBaseClient,
  createTenantClient,
  restrict,
  type TenantClient,
  tenantTransaction,
} from '../../src/platform/prisma/tenant-client';
import type { PrismaClient } from '../../src/generated/prisma/client';
import {
  connect,
  connectAsSuperuser,
  errorCode,
  inOrganisation,
  rows,
  seedTwoOrganisations,
  SQLSTATE,
  testDatabase,
  type TwoOrganisations,
} from './support/database';

/**
 * The row-level-security spike (M1-BE-02, ADR-05), against a real PostgreSQL whose
 * schema comes from `prisma migrate deploy`, connected as the application role.
 *
 * ST-05: nothing without an organisation; a reused pooled connection; 200 interleaved requests.
 * ST-06: a write into another organisation fails; a child cannot point at a foreign parent.
 */

const TENANT_TABLES = ['organisations', 'users', 'user_roles'] as const;
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

describe('tenant isolation by row-level security, as the application role', () => {
  jest.setTimeout(120_000);

  let superuser: Client;
  let app: Client;
  let orgs: TwoOrganisations;

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
    app = await connect(testDatabase.applicationUrl);
  });

  beforeEach(async () => {
    orgs = await seedTwoOrganisations(superuser);
  });

  afterAll(async () => {
    await app.end();
    await superuser.end();
  });

  it('the fixture has rows of two organisations, and the connection is the application role', async () => {
    const [who] = await rows<{ current_user: string }>(app, 'SELECT current_user');
    expect(who?.current_user).toBe('confera_app');
    const [count] = await rows<{ n: string }>(superuser, 'SELECT count(*) AS n FROM users');
    expect(Number(count?.n)).toBe(orgs.a.users.length + orgs.b.users.length);
  });

  describe('raw SQL', () => {
    describe('nothing without an organisation (ST-05)', () => {
      it.each(TENANT_TABLES)('SELECT from %s returns no row', async (table) => {
        expect(await rows(app, `SELECT * FROM ${table}`)).toEqual([]);
        expect(await inOrganisation(app, null, () => rows(app, `SELECT * FROM ${table}`))).toEqual(
          [],
        );
      });

      it('an empty setting is no organisation', async () => {
        const found = await inOrganisation(app, '', () => rows(app, 'SELECT * FROM users'));
        expect(found).toEqual([]);
      });

      it('an organisation that does not exist sees nothing', async () => {
        const found = await inOrganisation(app, ZERO_UUID, () => rows(app, 'SELECT * FROM users'));
        expect(found).toEqual([]);
      });

      it('a setting that is not a UUID is an error, not an open door', async () => {
        const code = await errorCode(() =>
          inOrganisation(app, "x' OR '1'='1", () => rows(app, 'SELECT * FROM users')),
        );
        expect(code).toBe(SQLSTATE.invalidTextRepresentation);
      });

      it('UPDATE and DELETE touch no row', async () => {
        const updated = await app.query("UPDATE users SET display_name = 'changed'");
        const deleted = await app.query('DELETE FROM user_roles');
        expect(updated.rowCount).toBe(0);
        expect(deleted.rowCount).toBe(0);
        const [left] = await rows<{ n: string }>(
          superuser,
          "SELECT count(*) AS n FROM users WHERE display_name = 'changed'",
        );
        expect(Number(left?.n)).toBe(0);
      });

      it('INSERT fails', async () => {
        const code = await errorCode(() =>
          app.query(
            "INSERT INTO users (organisation_id, email, display_name) VALUES ($1, 'nobody@example.test', 'Nobody')",
            [orgs.a.id],
          ),
        );
        expect(code).toBe(SQLSTATE.insufficientPrivilege);
      });
    });

    describe('A never sees B', () => {
      it('each organisation reads exactly its own rows, in every table', async () => {
        for (const [mine, other] of [
          [orgs.a, orgs.b],
          [orgs.b, orgs.a],
        ] as const) {
          const users = await inOrganisation(app, mine.id, () =>
            rows<{ id: string; organisation_id: string }>(app, 'SELECT * FROM users'),
          );
          expect(users.map((user) => user.id).sort()).toEqual(mine.users.map((u) => u.id).sort());

          const organisations = await inOrganisation(app, mine.id, () =>
            rows<{ id: string }>(app, 'SELECT * FROM organisations'),
          );
          expect(organisations.map((o) => o.id)).toEqual([mine.id]);

          const roles = await inOrganisation(app, mine.id, () =>
            rows<{ organisation_id: string }>(app, 'SELECT * FROM user_roles'),
          );
          expect(roles).toHaveLength(mine.users.length);
          expect(roles.every((role) => role.organisation_id === mine.id)).toBe(true);
          expect(roles.some((role) => role.organisation_id === other.id)).toBe(false);
        }
      });

      it.each([
        ['a filter on the other organisation', 'SELECT * FROM users WHERE organisation_id = $1'],
        [
          'a join',
          'SELECT u.* FROM users u JOIN organisations o ON o.id = u.organisation_id WHERE o.id = $1',
        ],
        [
          'a subquery',
          'SELECT * FROM users WHERE id IN (SELECT user_id FROM user_roles WHERE organisation_id = $1)',
        ],
        [
          'a union',
          'SELECT id FROM users WHERE organisation_id = $1 UNION ALL SELECT user_id FROM user_roles WHERE organisation_id = $1',
        ],
        [
          'a count',
          'SELECT count(*)::int AS n FROM users WHERE organisation_id = $1 HAVING count(*) > 0',
        ],
      ])('%s finds nothing of B from inside A', async (_name, sql) => {
        const found = await inOrganisation(app, orgs.a.id, () => rows(app, sql, [orgs.b.id]));
        expect(found).toEqual([]);
      });

      it('B cannot be found by a known id or email', async () => {
        const target = orgs.b.users[0]!;
        const found = await inOrganisation(app, orgs.a.id, () =>
          rows(app, 'SELECT * FROM users WHERE id = $1 OR email = $2', [target.id, target.email]),
        );
        expect(found).toEqual([]);
      });

      it('turning row security off in the session gives an error, not the rows', async () => {
        const other = await connect(testDatabase.applicationUrl);
        try {
          await other.query('SET row_security = off');
          const code = await errorCode(() => other.query('SELECT * FROM users'));
          expect(code).toBe(SQLSTATE.insufficientPrivilege);
        } finally {
          await other.end();
        }
      });
    });

    describe('a write into another organisation fails (ST-06)', () => {
      it('INSERT with the id of B, from inside A', async () => {
        const code = await errorCode(() =>
          inOrganisation(app, orgs.a.id, () =>
            app.query(
              "INSERT INTO users (organisation_id, email, display_name) VALUES ($1, 'intruder@example.test', 'Intruder')",
              [orgs.b.id],
            ),
          ),
        );
        expect(code).toBe(SQLSTATE.insufficientPrivilege);
        const found = await rows(
          superuser,
          "SELECT 1 FROM users WHERE email = 'intruder@example.test'",
        );
        expect(found).toEqual([]);
      });

      it('UPDATE that moves an own row into B', async () => {
        const code = await errorCode(() =>
          inOrganisation(app, orgs.a.id, () =>
            app.query('UPDATE users SET organisation_id = $1 WHERE id = $2', [
              orgs.b.id,
              orgs.a.users[2]!.id,
            ]),
          ),
        );
        // The composite foreign key of user_roles or the write check stops it; either way it fails.
        expect([SQLSTATE.insufficientPrivilege, SQLSTATE.foreignKeyViolation]).toContain(code);
        const [row] = await rows<{ organisation_id: string }>(
          superuser,
          'SELECT organisation_id FROM users WHERE id = $1',
          [orgs.a.users[2]!.id],
        );
        expect(row?.organisation_id).toBe(orgs.a.id);
      });

      it('UPDATE and DELETE of a row of B touch nothing', async () => {
        const target = orgs.b.users[0]!;
        const updated = await inOrganisation(app, orgs.a.id, () =>
          app.query("UPDATE users SET display_name = 'defaced' WHERE id = $1", [target.id]),
        );
        const deleted = await inOrganisation(app, orgs.a.id, () =>
          app.query('DELETE FROM users WHERE id = $1', [target.id]),
        );
        expect(updated.rowCount).toBe(0);
        expect(deleted.rowCount).toBe(0);
        const [row] = await rows<{ display_name: string }>(
          superuser,
          'SELECT display_name FROM users WHERE id = $1',
          [target.id],
        );
        expect(row?.display_name).toBe(target.displayName);
      });

      it('UPDATE of the organisation row of B touches nothing; renaming the own one works', async () => {
        const foreign = await inOrganisation(app, orgs.a.id, () =>
          app.query("UPDATE organisations SET name = 'taken over' WHERE id = $1", [orgs.b.id]),
        );
        const own = await inOrganisation(app, orgs.a.id, () =>
          app.query("UPDATE organisations SET name = 'Udruženje A, novo ime' WHERE id = $1", [
            orgs.a.id,
          ]),
        );
        expect(foreign.rowCount).toBe(0);
        expect(own.rowCount).toBe(1);
      });

      it('a child row cannot point at a parent of another organisation (composite foreign key)', async () => {
        const foreignUser = orgs.b.users[0]!.id;
        // Own organisation in the row, but the user of B: the foreign key says no.
        const viaKey = await errorCode(() =>
          inOrganisation(app, orgs.a.id, () =>
            app.query(
              "INSERT INTO user_roles (organisation_id, user_id, role) VALUES ($1, $2, 'admin')",
              [orgs.a.id, foreignUser],
            ),
          ),
        );
        expect(viaKey).toBe(SQLSTATE.foreignKeyViolation);
        // The organisation of B in the row: the write check says no.
        const viaPolicy = await errorCode(() =>
          inOrganisation(app, orgs.a.id, () =>
            app.query(
              "INSERT INTO user_roles (organisation_id, user_id, role) VALUES ($1, $2, 'reviewer')",
              [orgs.b.id, foreignUser],
            ),
          ),
        );
        expect(viaPolicy).toBe(SQLSTATE.insufficientPrivilege);
        // Even the superuser, who is above every policy, cannot create such a row.
        const asSuperuser = await errorCode(() =>
          superuser.query(
            "INSERT INTO user_roles (organisation_id, user_id, role) VALUES ($1, $2, 'admin')",
            [orgs.a.id, foreignUser],
          ),
        );
        expect(asSuperuser).toBe(SQLSTATE.foreignKeyViolation);
      });

      it('an organisation cannot be created or deleted by the application role', async () => {
        const created = await errorCode(() =>
          inOrganisation(app, ZERO_UUID, () =>
            app.query("INSERT INTO organisations (id, name) VALUES ($1, 'New')", [ZERO_UUID]),
          ),
        );
        const deleted = await errorCode(() =>
          inOrganisation(app, orgs.a.id, () =>
            app.query('DELETE FROM organisations WHERE id = $1', [orgs.a.id]),
          ),
        );
        expect(created).toBe(SQLSTATE.insufficientPrivilege);
        expect(deleted).toBe(SQLSTATE.insufficientPrivilege);
      });
    });

    describe('a reused connection carries nothing over (ST-05)', () => {
      it('after a transaction for A, the same connection without an organisation sees nothing', async () => {
        const inside = await inOrganisation(app, orgs.a.id, () => rows(app, 'SELECT * FROM users'));
        expect(inside).toHaveLength(orgs.a.users.length);
        // Same connection, next statement, no organisation.
        expect(await rows(app, 'SELECT * FROM users')).toEqual([]);
        const [setting] = await rows<{ value: string | null }>(
          app,
          "SELECT current_setting('app.org_id', true) AS value",
        );
        expect(setting?.value ?? '').toBe('');
      });

      it('after a rolled-back transaction for A too', async () => {
        await expect(
          inOrganisation(app, orgs.a.id, async () => {
            await app.query('SELECT 1/0');
          }),
        ).rejects.toThrow();
        expect(await rows(app, 'SELECT * FROM users')).toEqual([]);
      });

      it('after A, a transaction for B sees only B', async () => {
        await inOrganisation(app, orgs.a.id, () => rows(app, 'SELECT * FROM users'));
        const seen = await inOrganisation(app, orgs.b.id, () =>
          rows<{ organisation_id: string }>(app, 'SELECT * FROM users'),
        );
        expect(seen).toHaveLength(orgs.b.users.length);
        expect(seen.every((row) => row.organisation_id === orgs.b.id)).toBe(true);
      });
    });
  });

  describe('through the Prisma tenant client', () => {
    let base: PrismaClient;
    let current: string | undefined;
    let db: TenantClient;

    const as = async <T>(organisationId: string, work: () => Promise<T>): Promise<T> => {
      current = organisationId;
      try {
        return await work();
      } finally {
        current = undefined;
      }
    };

    beforeAll(() => {
      // A pool of ONE connection: every operation reuses the connection of the one before.
      base = createBaseClient(testDatabase.applicationUrl, { poolSize: 1 });
      db = restrict(
        createTenantClient(base, () => {
          if (current === undefined) {
            throw new Error('no organisation');
          }
          return current;
        }),
      );
    });

    afterAll(async () => {
      await base.$disconnect();
    });

    it('findMany returns only the rows of the organisation', async () => {
      const a = await as(orgs.a.id, () => db.user.findMany());
      const b = await as(orgs.b.id, () => db.user.findMany());
      expect(a.map((user) => user.id).sort()).toEqual(orgs.a.users.map((u) => u.id).sort());
      expect(b.map((user) => user.id).sort()).toEqual(orgs.b.users.map((u) => u.id).sort());
    });

    it('keeps š č ć ž đ as they are', async () => {
      const users = await as(orgs.a.id, () => db.user.findMany({ orderBy: { email: 'asc' } }));
      expect(users.map((user) => user.displayName)).toEqual([
        'Časlav Šćepanović',
        'Mila Petrović',
        'Živana Đorđević',
      ]);
    });

    it('nested relations stay inside the organisation', async () => {
      const organisations = await as(orgs.a.id, () =>
        db.organisation.findMany({
          include: { users: { include: { roles: true } }, userRoles: true },
        }),
      );
      expect(organisations.map((o) => o.id)).toEqual([orgs.a.id]);
      const users = organisations.flatMap((o) => o.users);
      expect(users).toHaveLength(orgs.a.users.length);
      expect(users.every((user) => user.organisationId === orgs.a.id)).toBe(true);
      expect(users.flatMap((user) => user.roles).every((r) => r.organisationId === orgs.a.id)).toBe(
        true,
      );
      expect(organisations[0]?.userRoles).toHaveLength(orgs.a.users.length);

      const roles = await as(orgs.a.id, () =>
        db.userRole.findMany({ include: { user: { include: { organisation: true } } } }),
      );
      expect(roles.every((role) => role.user.organisation.id === orgs.a.id)).toBe(true);
    });

    it('a relation filter cannot reach into B', async () => {
      const found = await as(orgs.a.id, () =>
        db.user.findMany({ where: { organisation: { id: orgs.b.id } } }),
      );
      const viaRole = await as(orgs.a.id, () =>
        db.userRole.findMany({ where: { user: { email: orgs.b.users[0]!.email } } }),
      );
      expect(found).toEqual([]);
      expect(viaRole).toEqual([]);
    });

    it('raw SQL through the tenant client stays inside the organisation', async () => {
      const seen = await as(
        orgs.a.id,
        () => db.$queryRaw<{ organisation_id: string }[]>`SELECT organisation_id FROM users`,
      );
      expect(seen).toHaveLength(orgs.a.users.length);
      expect(seen.every((row) => row.organisation_id === orgs.a.id)).toBe(true);

      const foreign = await as(
        orgs.a.id,
        () =>
          db.$queryRaw<unknown[]>`SELECT * FROM users WHERE organisation_id = ${orgs.b.id}::uuid`,
      );
      expect(foreign).toEqual([]);

      const changed = await as(
        orgs.a.id,
        () =>
          db.$executeRaw`UPDATE users SET display_name = 'defaced' WHERE organisation_id = ${orgs.b.id}::uuid`,
      );
      expect(changed).toBe(0);
    });

    it('count, aggregate and groupBy count only the organisation', async () => {
      expect(await as(orgs.a.id, () => db.user.count())).toBe(orgs.a.users.length);
      expect(await as(orgs.b.id, () => db.user.count())).toBe(orgs.b.users.length);
      const groups = await as(orgs.a.id, () =>
        db.userRole.groupBy({ by: ['organisationId'], _count: { _all: true } }),
      );
      expect(groups).toEqual([
        { organisationId: orgs.a.id, _count: { _all: orgs.a.users.length } },
      ]);
    });

    it('a record of B is not found by its id or its email', async () => {
      const target = orgs.b.users[0]!;
      expect(
        await as(orgs.a.id, () => db.user.findUnique({ where: { id: target.id } })),
      ).toBeNull();
      expect(
        await as(orgs.a.id, () => db.user.findUnique({ where: { email: target.email } })),
      ).toBeNull();
      expect(await as(orgs.a.id, () => db.user.findFirst({ where: { id: target.id } }))).toBeNull();
    });

    it('update, delete and upsert of a record of B fail and change nothing', async () => {
      const target = orgs.b.users[0]!;
      await expect(
        as(orgs.a.id, () =>
          db.user.update({ where: { id: target.id }, data: { displayName: 'defaced' } }),
        ),
      ).rejects.toThrow();
      await expect(
        as(orgs.a.id, () => db.user.delete({ where: { id: target.id } })),
      ).rejects.toThrow();
      await expect(
        as(orgs.a.id, () =>
          db.user.upsert({
            where: { id: target.id },
            update: { displayName: 'defaced' },
            create: {
              id: target.id,
              organisationId: orgs.a.id,
              email: 'x@example.test',
              displayName: 'X',
            },
          }),
        ),
      ).rejects.toThrow();
      expect(
        (
          await as(orgs.a.id, () =>
            db.user.updateMany({ data: { displayName: 'Ista osoba' }, where: { id: target.id } }),
          )
        ).count,
      ).toBe(0);
      expect(
        (await as(orgs.a.id, () => db.user.deleteMany({ where: { organisationId: orgs.b.id } })))
          .count,
      ).toBe(0);

      const [row] = await rows<{ display_name: string }>(
        superuser,
        'SELECT display_name FROM users WHERE id = $1',
        [target.id],
      );
      expect(row?.display_name).toBe(target.displayName);
    });

    it('create and createMany into B fail and write nothing (ST-06)', async () => {
      await expect(
        as(orgs.a.id, () =>
          db.user.create({
            data: {
              organisationId: orgs.b.id,
              email: 'intruder@example.test',
              displayName: 'Intruder',
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        as(orgs.a.id, () =>
          db.user.createMany({
            data: [
              { organisationId: orgs.a.id, email: 'fine@a.example.test', displayName: 'Fine' },
              {
                organisationId: orgs.b.id,
                email: 'intruder2@example.test',
                displayName: 'Intruder',
              },
            ],
          }),
        ),
      ).rejects.toThrow();
      await expect(
        as(orgs.a.id, () =>
          db.userRole.create({
            data: { organisationId: orgs.a.id, userId: orgs.b.users[0]!.id, role: 'admin' },
          }),
        ),
      ).rejects.toThrow();
      const written = await rows(
        superuser,
        "SELECT email FROM users WHERE email IN ('intruder@example.test', 'intruder2@example.test', 'fine@a.example.test')",
      );
      expect(written).toEqual([]);
    });

    it('a create inside the own organisation works', async () => {
      const created = await as(orgs.a.id, () =>
        db.user.create({
          data: {
            organisationId: orgs.a.id,
            email: 'nova.osoba@a.example.test',
            displayName: 'Nova Osoba',
            roles: { create: { role: 'reviewer' } },
          },
          include: { roles: true },
        }),
      );
      expect(created.organisationId).toBe(orgs.a.id);
      expect(created.roles).toHaveLength(1);
      expect(
        await as(orgs.b.id, () => db.user.findUnique({ where: { id: created.id } })),
      ).toBeNull();
    });

    it('without an organisation nothing reaches the database', async () => {
      await expect(db.user.findMany()).rejects.toThrow('no organisation');
      await expect(db.$queryRaw`SELECT 1`).rejects.toThrow('no organisation');
    });

    it('the plain client of the application role, with no organisation, gets nothing (the backstop)', async () => {
      expect(await base.user.findMany()).toEqual([]);
      expect(await base.organisation.findMany()).toEqual([]);
      expect(await base.$queryRaw`SELECT * FROM user_roles`).toEqual([]);
      await expect(
        base.user.create({
          data: { organisationId: orgs.a.id, email: 'nobody@example.test', displayName: 'Nobody' },
        }),
      ).rejects.toThrow();
    });

    it('the tenant client offers no transaction of its own', () => {
      expect(() => (db as unknown as { $transaction: unknown }).$transaction).toThrow(
        /not available on the tenant client/,
      );
    });

    it('after an operation for A, the pooled connection has no organisation left (ST-05)', async () => {
      await as(orgs.a.id, () => db.user.findMany());
      // The pool has one connection, so this is the connection that just served A.
      expect(await base.user.findMany()).toEqual([]);
      const setting = await base.$queryRaw<{ value: string | null }[]>`
        SELECT current_setting('app.org_id', true) AS value`;
      expect(setting[0]?.value ?? '').toBe('');
    });

    it('after a failed operation for A, the pooled connection has no organisation left', async () => {
      await expect(as(orgs.a.id, () => db.$queryRaw`SELECT 1/0`)).rejects.toThrow();
      expect(await base.user.findMany()).toEqual([]);
    });

    describe('a transaction of several statements', () => {
      it('sees and writes only the organisation, and commits together', async () => {
        const result = await tenantTransaction(base, orgs.a.id, async (tx) => {
          const before = await tx.user.count();
          const created = await tx.user.create({
            data: {
              organisationId: orgs.a.id,
              email: 'u.transakciji@a.example.test',
              displayName: 'U Transakciji',
            },
          });
          await tx.userRole.create({
            data: { organisationId: orgs.a.id, userId: created.id, role: 'reviewer' },
          });
          const raw = await tx.$queryRaw<
            { organisation_id: string }[]
          >`SELECT organisation_id FROM users`;
          return { before, after: await tx.user.count(), raw };
        });
        expect(result.before).toBe(orgs.a.users.length);
        expect(result.after).toBe(orgs.a.users.length + 1);
        expect(result.raw.every((row) => row.organisation_id === orgs.a.id)).toBe(true);
      });

      it('rolls back as a whole when a statement writes into B', async () => {
        await expect(
          tenantTransaction(base, orgs.a.id, async (tx) => {
            await tx.user.create({
              data: {
                organisationId: orgs.a.id,
                email: 'rolled.back@a.example.test',
                displayName: 'Rolled Back',
              },
            });
            await tx.user.create({
              data: {
                organisationId: orgs.b.id,
                email: 'intruder3@example.test',
                displayName: 'Intruder',
              },
            });
          }),
        ).rejects.toThrow();
        const written = await rows(
          superuser,
          "SELECT 1 FROM users WHERE email IN ('rolled.back@a.example.test', 'intruder3@example.test')",
        );
        expect(written).toEqual([]);
        expect(await base.user.findMany()).toEqual([]);
      });
    });

    describe('200 interleaved requests of two organisations (ST-05)', () => {
      it.each([
        ['a pool of one connection', 1],
        ['a pool of five connections', 5],
      ])('with %s, no request gets a foreign row', async (_name, poolSize) => {
        const pooled = createBaseClient(testDatabase.applicationUrl, { poolSize });
        try {
          const requests = Array.from({ length: 200 }, (_unused, index) => {
            const mine = index % 2 === 0 ? orgs.a : orgs.b;
            // Each request has its own tenant client bound to its organisation, as each
            // HTTP request has its own context; all share the one pool.
            const client = createTenantClient(pooled, () => mine.id);
            const kind = index % 4;
            const work =
              kind === 0
                ? client.user.findMany()
                : kind === 1
                  ? client.user.findMany({ include: { roles: true, organisation: true } })
                  : kind === 2
                    ? client.$queryRaw<{ organisationId: string }[]>`
                        SELECT organisation_id AS "organisationId" FROM users`
                    : client.userRole.findMany();
            return (work as Promise<{ organisationId: string }[]>).then((found) => ({
              mine,
              found,
            }));
          });
          const results = await Promise.all(requests);

          expect(results).toHaveLength(200);
          let checked = 0;
          for (const { mine, found } of results) {
            expect(found).toHaveLength(mine.users.length);
            for (const row of found) {
              expect(row.organisationId).toBe(mine.id);
              checked += 1;
            }
          }
          expect(checked).toBe(100 * orgs.a.users.length + 100 * orgs.b.users.length);
        } finally {
          await pooled.$disconnect();
        }
      });

      it('interleaved transactions of two organisations on one connection stay apart', async () => {
        const pooled = createBaseClient(testDatabase.applicationUrl, { poolSize: 1 });
        try {
          const results = await Promise.all(
            Array.from({ length: 40 }, (_unused, index) => {
              const mine = index % 2 === 0 ? orgs.a : orgs.b;
              return tenantTransaction(pooled, mine.id, async (tx) => {
                const users = await tx.user.findMany();
                await new Promise((resolve) => setTimeout(resolve, index % 3));
                const again = await tx.$queryRaw<{ organisation_id: string }[]>`
                  SELECT organisation_id FROM user_roles`;
                return { mine, users, again };
              });
            }),
          );
          for (const { mine, users, again } of results) {
            expect(users.every((user) => user.organisationId === mine.id)).toBe(true);
            expect(users).toHaveLength(mine.users.length);
            expect(again.every((row) => row.organisation_id === mine.id)).toBe(true);
          }
        } finally {
          await pooled.$disconnect();
        }
      });
    });
  });
});
