import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, QueryResultRow } from 'pg';
import { repoRoot, runNode } from '../support/run-node';
import { connectAsOwner, e2eDatabase } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * E2-14 (ADR-03, ST-23, M2-BE-11): the command that creates the first admin has an address
 * rule of its own, a looser one than "ONE plain address, ASCII, a dot-atom" of the
 * application (src/common/validation/mail-address.ts, "an address that Confera stores or
 * sends to"). The first admin, who receives every security notice of the organisation, can
 * be created with an address that the application would refuse for anybody else.
 */
const SEED = join('scripts', 'seed-production.mjs');
const FIRST_ADMIN = join('scripts', 'first-admin.mjs');
const ORGANISATION = (
  JSON.parse(readFileSync(join(repoRoot, 'prisma', 'seed', 'production.json'), 'utf8')) as {
    organisation: { id: string };
  }
).organisation.id;

describe('the first admin command and the address rule (E2-14)', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  const env = () => ({
    STAGE: 'prod',
    MIGRATION_DATABASE_URL: e2eDatabase.ownerUrl,
    ADMIN_ORIGIN: 'https://admin.confera.test',
  });

  async function users(): Promise<QueryResultRow[]> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [ORGANISATION]);
      const result = await owner.query('SELECT email FROM users');
      await owner.query('COMMIT');
      return result.rows as QueryResultRow[];
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    const seeded = await runNode([SEED], { env: env() });
    expect(seeded.exitCode).toBe(0);
  });

  afterEach(async () => {
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.org_id', $1, true)", [ORGANISATION]);
    await owner.query('DELETE FROM secure_links');
    await owner.query('DELETE FROM user_roles');
    await owner.query('DELETE FROM users');
    await owner.query('COMMIT');
  });

  afterAll(async () => {
    await new Factories(owner).reset();
    await owner.end();
  });

  it.each([
    ['two dots', 'ana..admin@prva.example.test'],
    ['a backslash', 'ana\\admin@prva.example.test'],
    ['parentheses', 'ana(admin)@prva.example.test'],
    ['a letter with a caron', 'šima.admin@prva.example.test'],
    ['a leading dot', '.ana@prva.example.test'],
  ])('refuses an address with %s, as the application does', async (_name, email) => {
    const result = await runNode([FIRST_ADMIN, '--email', email, '--name', 'Prva Osoba'], {
      env: env(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(await users()).toEqual([]);
  });
});
