import { Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import type { Client } from 'pg';
import { AppLogger, createRootLogger } from '../../src/common/logging/app-logger';
import { LoggingModule } from '../../src/common/logging/logging.module';
import { parseEnvironment } from '../../src/config/config';
import { ConfigModule } from '../../src/config/config.module';
import { validEnvironment } from '../../src/config/testing/valid-environment';
import { PrismaModule } from '../../src/platform/prisma/prisma.module';
import { SystemResolvers } from '../../src/platform/prisma/system/resolvers';
import { TenantDatabase } from '../../src/platform/prisma/tenant-database';
import { NoOrganisationError, TenantContext } from '../../src/platform/tenancy/tenant-context';
import {
  connectAsSuperuser,
  rows,
  seedTwoOrganisations,
  testDatabase,
  type TwoOrganisations,
} from './support/database';

/**
 * The data-access module as the application uses it: TenantContext (the organisation of
 * the current request, kept in the request context), TenantDatabase and SystemResolvers,
 * wired by Nest and connected as the two run-time roles. The start-up role check runs
 * for real when the module starts.
 */
describe('data access through the Nest module', () => {
  jest.setTimeout(120_000);

  let superuser: Client;
  let moduleRef: TestingModule;
  let context: TenantContext;
  let database: TenantDatabase;
  let resolvers: SystemResolvers;
  let orgs: TwoOrganisations;

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
    const config = parseEnvironment(
      validEnvironment({
        DATABASE_URL: testDatabase.applicationUrl,
        SYSTEM_DATABASE_URL: testDatabase.systemUrl,
      }),
    );
    if (!config.ok) {
      throw new Error('test configuration is not valid');
    }
    const logger = new AppLogger(createRootLogger('fatal', { write: () => undefined }));

    @Module({
      imports: [
        ConfigModule.register(config.config),
        LoggingModule.register(logger),
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        PrismaModule,
      ],
    })
    class DataAccessModule {}

    moduleRef = await Test.createTestingModule({ imports: [DataAccessModule] }).compile();
    await moduleRef.init();
    context = moduleRef.get(TenantContext);
    database = moduleRef.get(TenantDatabase);
    resolvers = moduleRef.get(SystemResolvers);
  });

  beforeEach(async () => {
    orgs = await seedTwoOrganisations(superuser);
  });

  afterAll(async () => {
    await moduleRef.close();
    await superuser.end();
  });

  describe('TenantDatabase', () => {
    it('works inside the organisation of the context', async () => {
      const a = await context.run(orgs.a.id, () => database.db.user.findMany());
      const b = await context.run(orgs.b.id, () => database.db.user.findMany());
      expect(a.map((user) => user.id).sort()).toEqual(orgs.a.users.map((u) => u.id).sort());
      expect(b.map((user) => user.id).sort()).toEqual(orgs.b.users.map((u) => u.id).sort());
    });

    it('throws before anything reaches the database when no organisation is set', async () => {
      await expect(database.db.user.findMany()).rejects.toThrow(NoOrganisationError);
      await expect(database.db.$queryRaw`SELECT 1`).rejects.toThrow(NoOrganisationError);
      expect(() => database.transaction(() => Promise.resolve())).toThrow(NoOrganisationError);
    });

    it('the organisation ends with the work it was set for', async () => {
      await context.run(orgs.a.id, () => database.db.user.count());
      expect(context.organisationId()).toBeUndefined();
      await expect(database.db.user.count()).rejects.toThrow(NoOrganisationError);
    });

    it('refuses an organisation id that is not a UUID, and a change of organisation inside one', async () => {
      await expect(
        context.run("x'; DROP TABLE users; --", () => Promise.resolve()),
      ).rejects.toThrow(TypeError);
      await expect(
        context.run(orgs.a.id, () => context.run(orgs.b.id, () => database.db.user.findMany())),
      ).rejects.toThrow(/nested change is not allowed/);
      // The same organisation again is fine.
      const nested = await context.run(orgs.a.id, () =>
        context.run(orgs.a.id, () => database.db.user.count()),
      );
      expect(nested).toBe(orgs.a.users.length);
    });

    it('a transaction runs inside the organisation and rolls back as a whole', async () => {
      const count = await context.run(orgs.a.id, () =>
        database.transaction(async (tx) => {
          await tx.user.create({
            data: { organisationId: orgs.a.id, email: 'nova@a.example.test', displayName: 'Nova' },
          });
          return tx.user.count();
        }),
      );
      expect(count).toBe(orgs.a.users.length + 1);

      await expect(
        context.run(orgs.a.id, () =>
          database.transaction(async (tx) => {
            await tx.user.create({
              data: {
                organisationId: orgs.a.id,
                email: 'gone@a.example.test',
                displayName: 'Gone',
              },
            });
            await tx.user.create({
              data: {
                organisationId: orgs.b.id,
                email: 'intruder@example.test',
                displayName: 'Intruder',
              },
            });
          }),
        ),
      ).rejects.toThrow();
      const left = await rows(
        superuser,
        "SELECT 1 FROM users WHERE email IN ('gone@a.example.test', 'intruder@example.test')",
      );
      expect(left).toEqual([]);
    });

    it('200 interleaved requests of two organisations, each in its own context (ST-05)', async () => {
      const results = await Promise.all(
        Array.from({ length: 200 }, (_unused, index) => {
          const mine = index % 2 === 0 ? orgs.a : orgs.b;
          return context.run(mine.id, async () => {
            // Give other requests the chance to run in between, as awaits do in real code.
            await new Promise((resolve) => setTimeout(resolve, index % 5));
            const users = await database.db.user.findMany({ include: { roles: true } });
            const raw = await database.db.$queryRaw<{ organisation_id: string }[]>`
              SELECT organisation_id FROM user_roles`;
            return { mine, users, raw, seenAs: context.organisationId() };
          });
        }),
      );
      for (const { mine, users, raw, seenAs } of results) {
        expect(seenAs).toBe(mine.id);
        expect(users).toHaveLength(mine.users.length);
        expect(users.every((user) => user.organisationId === mine.id)).toBe(true);
        expect(users.flatMap((user) => user.roles).every((r) => r.organisationId === mine.id)).toBe(
          true,
        );
        expect(raw.every((row) => row.organisation_id === mine.id)).toBe(true);
      }
    });

    it('says whether the database answers', async () => {
      expect(await database.isReachable()).toBe(true);
    });
  });

  describe('SystemResolvers (ADR-05)', () => {
    it('finds a user of any organisation by email and returns the two ids, nothing else', async () => {
      for (const organisation of [orgs.a, orgs.b]) {
        for (const user of organisation.users) {
          const resolved = await resolvers.userByEmail(user.email);
          expect(resolved).toEqual({ organisationId: organisation.id, userId: user.id });
          expect(Object.keys(resolved ?? {}).sort()).toEqual(['organisationId', 'userId']);
        }
      }
    });

    it('ignores the case of the address', async () => {
      const user = orgs.a.users[0]!;
      expect(await resolvers.userByEmail(user.email.toUpperCase())).toEqual({
        organisationId: orgs.a.id,
        userId: user.id,
      });
    });

    it.each(['nobody@example.test', '', '%', "x' OR '1'='1", '*@a.example.test'])(
      'answers null for "%s"',
      async (email) => {
        expect(await resolvers.userByEmail(email)).toBeNull();
      },
    );

    it('needs no organisation in the context, and sets none', async () => {
      expect(context.organisationId()).toBeUndefined();
      await resolvers.userByEmail(orgs.a.users[0]!.email);
      expect(context.organisationId()).toBeUndefined();
    });

    it('sign-in as it will work: resolve, then read through the tenant client', async () => {
      const email = orgs.b.users[0]!.email;
      const resolved = await resolvers.userByEmail(email);
      expect(resolved).not.toBeNull();
      const user = await context.run(resolved!.organisationId, () =>
        database.db.user.findUnique({ where: { id: resolved!.userId } }),
      );
      // The password hash comes from the tenant client, inside the resolved organisation.
      expect(user?.passwordHash).toBe(`invented-hash-of-${email}`);
      expect(user?.organisationId).toBe(orgs.b.id);
    });
  });
});
