import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { TenantDatabase } from '../../src/platform/prisma/tenant-database';
import { TenantContext } from '../../src/platform/tenancy/tenant-context';
import { repoRoot, runNode } from '../support/run-node';
import { as, signIn } from './support/actors';
import { ADMIN_HOST, type E2eApp, startE2eApp } from './support/e2e-app';
import { connect, connectAsOwner, e2eDatabase, rows } from './support/e2e-database';
import { assertInvented, Factories } from './support/factories';

/**
 * `pnpm seed:e2e` (M1-QA-02, ADR-24): the known state both repositories' end-to-end
 * tests start from. It writes invented people only, is safe to repeat, and REFUSES to
 * run outside the stages `local` and `test`: the proof of the refusal is here, against
 * a real database, and in test/tooling/seed-e2e-guard.spec.ts without one.
 */

const SEED = join('scripts', 'seed-e2e.mjs');
const EXIT_CONFIGURATION = 78;

interface SeedFile {
  readonly organisations: readonly {
    readonly id: string;
    readonly name: string;
    readonly users: readonly {
      readonly id: string;
      readonly email: string;
      readonly displayName: string;
      readonly role: string;
      readonly password?: string;
    }[];
    readonly conferences?: readonly { readonly form: { readonly id: string } }[];
  }[];
}

/** A schema of the OpenAPI document, as far as the check of `publishedBy` reads it. */
interface Schema {
  readonly $ref?: string;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
}

const contractSchemas = (
  JSON.parse(readFileSync(join(repoRoot, 'openapi', 'openapi.json'), 'utf8')) as {
    components: { schemas: Record<string, Schema> };
  }
).components.schemas;

/** The schema of `publishedBy` in a version summary, as the contract states it. */
function publishedByInContract(): Schema {
  const summary = contractSchemas.FormVersionSummaryDto;
  const property = summary?.properties?.publishedBy;
  if (property === undefined) {
    throw new Error('the contract has no FormVersionSummaryDto.publishedBy');
  }
  expect(summary?.required).toContain('publishedBy');
  return property.$ref === undefined
    ? property
    : (contractSchemas[property.$ref.split('/').pop() ?? ''] ?? {});
}

/** The problems of a value against an object schema of plain string properties. */
function problemsOf(value: unknown, schema: Schema): string[] {
  if (value === null) {
    return schema.nullable === true ? [] : ['null where the contract allows no null'];
  }
  if (typeof value !== 'object') {
    return [`a ${typeof value} where the contract wants an object`];
  }
  const record = value as Record<string, unknown>;
  return [
    ...(schema.required ?? []).filter((key) => !(key in record)).map((key) => `no ${key}`),
    ...Object.entries(schema.properties ?? {})
      .filter(([key, property]) => key in record && typeof record[key] !== property.type)
      .map(([key, property]) => `${key} is not a ${property.type ?? '?'}`),
  ];
}

const seed = JSON.parse(
  readFileSync(join(repoRoot, 'test', 'e2e', 'seed', 'e2e-seed.json'), 'utf8'),
) as SeedFile;
const seededPeople = seed.organisations.flatMap((organisation) => organisation.users);

describe('seed:e2e', () => {
  jest.setTimeout(120_000);

  let owner: Client;
  let system: Client;
  let e2e: E2eApp;

  const run = (stage: string | undefined) =>
    runNode([SEED], { env: { STAGE: stage, MIGRATION_DATABASE_URL: e2eDatabase.ownerUrl } });

  const peopleInDatabase = async (): Promise<string[]> =>
    (await rows<{ email: string }>(system, 'SELECT email FROM users ORDER BY email')).map(
      (row) => row.email,
    );

  beforeAll(async () => {
    owner = await connectAsOwner();
    system = await connect(e2eDatabase.systemUrl);
    await new Factories(owner).reset();
    e2e = await startE2eApp();
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await system.end();
    await owner.end();
  });

  describe('the seed file', () => {
    it('holds invented people only, each on example.test', () => {
      expect(seededPeople.length).toBeGreaterThan(0);
      for (const person of seededPeople) {
        expect(() => {
          assertInvented(person.email);
        }).not.toThrow();
        // A password, where there is one, is an invented placeholder; never a hash.
        expect(person.password ?? 'invented-').toMatch(/^invented-/);
        expect(person).not.toHaveProperty('passwordHash');
      }
    });

    it('holds two organisations, so that every later test can ask for the other one', () => {
      expect(seed.organisations.length).toBeGreaterThanOrEqual(2);
      const ids = [
        ...seed.organisations.map((organisation) => organisation.id),
        ...seededPeople.map((person) => person.id),
      ];
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('says in each organisation name that it is invented', () => {
      for (const organisation of seed.organisations) {
        expect(organisation.name).toContain('(izmišljeno)');
      }
    });
  });

  describe('refuses to run outside local and test', () => {
    it.each([
      ['prod', 'prod'],
      ['dev', 'dev'],
      ['unset', undefined],
      ['empty', ''],
      ['the long word', 'production'],
      ['upper case', 'TEST'],
      ['a trailing space', 'test '],
      ['staging', 'staging'],
    ])('STAGE %s: exit code 78, and not one row is written', async (_name, stage) => {
      const result = await run(stage);
      expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({
        exitCode: EXIT_CONFIGURATION,
        stdout: '',
      });
      expect(result.stderr).toContain('seed:e2e did not run');
      expect(result.stderr).toContain('  - STAGE: ');
      expect(await peopleInDatabase()).toEqual([]);
    });

    it('prints no value of a variable when it refuses', async () => {
      const result = await runNode([SEED], {
        env: {
          STAGE: 'canary-stage-51ab',
          MIGRATION_DATABASE_URL: e2eDatabase.ownerUrl,
        },
      });
      expect(result.exitCode).toBe(EXIT_CONFIGURATION);
      expect(result.output).not.toContain('canary-stage-51ab');
      expect(result.output).not.toContain(new URL(e2eDatabase.ownerUrl).password);
    });
  });

  describe.each(['test', 'local'])('on STAGE=%s', (stage) => {
    it('writes the organisations and people of the seed file', async () => {
      const result = await run(stage);
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: '',
      });
      expect(result.stdout).toContain(
        `${String(seed.organisations.length)} organisations and ${String(seededPeople.length)} invented people`,
      );
      expect(result.stdout).toContain(`"${e2eDatabase.name}"`);
      expect(await peopleInDatabase()).toEqual(seededPeople.map((person) => person.email).sort());
    });

    it('prints no password', async () => {
      const result = await run(stage);
      expect(result.output).not.toContain(new URL(e2eDatabase.ownerUrl).password);
      expect(result.output).not.toContain('postgresql://');
    });
  });

  describe('what it leaves in the database', () => {
    beforeAll(async () => {
      expect((await run('test')).exitCode).toBe(0);
    });

    it('is the same after a second and a third run: never a second copy', async () => {
      expect((await run('test')).exitCode).toBe(0);
      expect((await run('test')).exitCode).toBe(0);
      expect(await peopleInDatabase()).toEqual(seededPeople.map((person) => person.email).sort());
    });

    it.each(seed.organisations)(
      'the application reads "$name" with its own people and nobody else',
      async (organisation) => {
        const context = e2e.app.get(TenantContext);
        const database = e2e.app.get(TenantDatabase);
        const found = await context.run(organisation.id, async () => ({
          organisations: await database.db.organisation.findMany(),
          users: await database.db.user.findMany({
            include: { roles: true },
            orderBy: { email: 'asc' },
          }),
        }));
        expect(found.organisations).toEqual([
          expect.objectContaining({ id: organisation.id, name: organisation.name }),
        ]);
        expect(
          found.users.map((user) => ({
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            role: user.roles.map((role) => role.role).join(','),
            organisationId: user.organisationId,
            status: user.status,
            argon2id: user.passwordHash?.startsWith('$argon2id$v=19$m=19456,t=2,p=1$') ?? false,
          })),
        ).toEqual(
          [...organisation.users]
            .sort((x, y) => (x.email < y.email ? -1 : 1))
            .map(({ password, ...user }) => ({
              ...user,
              organisationId: organisation.id,
              // A person with an invented password is active and signs in (the web
              // application's sign-in tests); the hash is the application's argon2id.
              status: password === undefined ? 'invited' : 'active',
              argon2id: password !== undefined,
            })),
        );
        expect(await context.run(organisation.id, () => database.db.mailTemplate.count())).toBe(16);
      },
    );

    it('repairs a seeded row that a test changed', async () => {
      const person = seededPeople[0]!;
      const organisation = seed.organisations[0]!;
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.org_id', $1, true)", [organisation.id]);
      await owner.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Changed', person.id]);
      await owner.query('COMMIT');

      expect((await run('test')).exitCode).toBe(0);

      const context = e2e.app.get(TenantContext);
      const database = e2e.app.get(TenantDatabase);
      const stored = await context.run(organisation.id, () =>
        database.db.user.findUnique({ where: { id: person.id } }),
      );
      expect(stored?.displayName).toBe(person.displayName);
    });
  });

  it('publishes the abstract form of the seeded conference under its fixed address (M3)', async () => {
    expect((await run('test')).exitCode).toBe(0);
    const response = await e2e.public('/public/v1/forms/e2eprobnaforma01');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({ slug: 'e2eprobnaforma01', state: 'open', versionNumber: 1 }),
    );
  });

  it('the seeded form, as its admin sees it, names a publisher as the contract says (blank-slate run 2)', async () => {
    expect((await run('test')).exitCode).toBe(0);
    const organisation = seed.organisations.find((entry) => (entry.conferences ?? []).length > 0);
    const formId = organisation?.conferences?.[0]?.form.id ?? '';
    const admin = organisation?.users.find((user) => user.role === 'admin');
    expect(admin?.password).toBeDefined();
    const signedIn = await signIn(e2e, { email: admin?.email ?? '' }, admin?.password);

    const response = await as(e2e, signedIn, 'get', `/api/v1/forms/${formId}`);
    expect(response.status).toBe(200);
    const body = response.body as {
      currentVersion: { number: number; publishedBy: unknown } | null;
      versions: { number: number; publishedBy: unknown }[];
    };
    const contract = publishedByInContract();
    expect(body.versions.length).toBeGreaterThan(0);
    for (const version of [body.currentVersion, ...body.versions]) {
      expect({
        version: version?.number,
        problems: problemsOf(version?.publishedBy, contract),
      }).toEqual({
        version: version?.number,
        problems: [],
      });
    }
    // The publisher is the seeded admin, under the name of the seed file.
    expect(body.currentVersion?.publishedBy).toEqual({
      id: admin?.id,
      displayName: admin?.displayName,
    });

    const detail = await as(e2e, signedIn, 'get', `/api/v1/forms/${formId}/versions/1`);
    expect(detail.status).toBe(200);
    expect((detail.body as { publishedBy: unknown }).publishedBy).toEqual({
      id: admin?.id,
      displayName: admin?.displayName,
    });
  });

  it('signs a seeded person in with the password of the seed file', async () => {
    expect((await run('test')).exitCode).toBe(0);
    const person = seededPeople.find((user) => user.password !== undefined);
    expect(person).toBeDefined();
    const response = await e2e
      .http()
      .post('/api/v1/session')
      .set('Host', ADMIN_HOST)
      .set('Origin', e2e.config.origins.admin)
      .send({ email: person?.email, password: person?.password });
    expect(response.status).toBe(200);
  });

  describe('when the database is not there', () => {
    it('fails with a sentence, exit code 1, and no address or password', async () => {
      const result = await runNode([SEED], {
        env: {
          STAGE: 'test',
          MIGRATION_DATABASE_URL: 'postgresql://confera_owner:invented-gone@127.0.0.1:1/x',
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('seed:e2e failed: cannot connect to PostgreSQL');
      expect(result.output).not.toContain('invented-gone');
      expect(result.output).not.toContain('127.0.0.1');
    });
  });
});
