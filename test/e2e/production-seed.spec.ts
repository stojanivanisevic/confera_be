import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, QueryResultRow } from 'pg';
import { digestOf } from '../../src/modules/access/tokens';
import { repoRoot, runNode } from '../support/run-node';
import { ADMIN_HOST, type E2eApp, e2eEnvironment, startE2eApp } from './support/e2e-app';
import { connectAsOwner, e2eDatabase } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * ST-27 (M2-BE-11, SEC-A-27): the production seed writes the organisation, its templates
 * and the five conferences as drafts, and no user with a password; the first-admin command
 * creates an invitation only and prints its link once, to the terminal; the application
 * starts and stays healthy with no mail server.
 */
const SEED = join('scripts', 'seed-production.mjs');
const FIRST_ADMIN = join('scripts', 'first-admin.mjs');

const production = JSON.parse(
  readFileSync(join(repoRoot, 'prisma', 'seed', 'production.json'), 'utf8'),
) as {
  organisation: { id: string; name: string };
  conferences: { code: string; name: string; site: string }[];
};
const ORGANISATION = production.organisation.id;
const ADMIN_EMAIL = 'prva.administratorka@udekom.example.test';

describe('the production seed and the first admin (ST-27)', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp | undefined;

  async function inOrganisation<T extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [ORGANISATION]);
      const result = await owner.query<T>(sql, values);
      await owner.query('COMMIT');
      return result.rows;
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  const env = (stage = 'prod') => ({
    STAGE: stage,
    MIGRATION_DATABASE_URL: e2eDatabase.ownerUrl,
    ADMIN_ORIGIN: 'https://admin.confera.test',
  });
  const seed = (stage = 'prod') => runNode([SEED], { env: env(stage) });
  const firstAdmin = (args: string[], stage = 'prod') =>
    runNode([FIRST_ADMIN, ...args], { env: env(stage) });

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
  });

  afterAll(async () => {
    await e2e?.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  it('refuses to run without a stage, and writes nothing', async () => {
    const result = await runNode([SEED], { env: { MIGRATION_DATABASE_URL: e2eDatabase.ownerUrl } });
    expect(result.exitCode).toBe(78);
    expect(await inOrganisation('SELECT id FROM organisations')).toEqual([]);
  });

  it('writes the organisation, its templates and the five conferences as drafts; no user (FR-CONF-02)', async () => {
    const result = await seed();
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: '',
    });
    expect(result.stdout).toContain('No user was created');

    const conferences = await inOrganisation<{
      code: string;
      name: string;
      state: string;
      listed_sites: string[];
      edition_year: number | null;
      starts_on: Date | null;
      ends_on: Date | null;
    }>(
      'SELECT code, name, state, listed_sites, edition_year, starts_on, ends_on FROM conferences ORDER BY code',
    );
    expect(conferences).toEqual(
      production.conferences
        .map((conference) => ({
          code: conference.code,
          name: conference.name,
          state: 'draft',
          listed_sites: [conference.site],
          edition_year: null,
          starts_on: null,
          ends_on: null,
        }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );
    expect(conferences.map(({ code }) => code).sort()).toEqual(['AI', 'EM', 'ER', 'IT', 'LI']);
    const templates = await inOrganisation<{ type: string; language: string }>(
      'SELECT type, language FROM mail_templates WHERE conference_id IS NULL ORDER BY type, language',
    );
    // Fifteen types in English and Serbian: the confirmation of a submission came with 0.3.0,
    // the seven status emails of Spec section 5 with 0.4.0 (FR-MAIL-03).
    expect(templates).toHaveLength(30);
    expect(
      templates.filter(({ type }) => type === 'invitation' || type === 'password_reset'),
    ).toHaveLength(4);
    expect(await inOrganisation('SELECT id FROM users')).toEqual([]);
    expect(await inOrganisation('SELECT id FROM mail_servers')).toEqual([]);
    // Each conference has its abstract form, a draft with the catalogue's defaults (M3-BE-01).
    const forms = await inOrganisation<{ type: string; current_version_id: string | null }>(
      'SELECT type, current_version_id FROM forms',
    );
    expect(forms).toEqual(
      Array.from({ length: 5 }, () => ({ type: 'abstract', current_version_id: null })),
    );
  });

  it('is the same after a second run: never a second copy, an edit kept', async () => {
    await inOrganisation("UPDATE conferences SET venue = 'Beograd' WHERE code = 'IT'");
    const result = await seed();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      '0 new templates, 0 new conference drafts and 0 new abstract forms',
    );
    expect(await inOrganisation('SELECT id FROM forms')).toHaveLength(5);
    expect(await inOrganisation('SELECT id FROM conferences')).toHaveLength(5);
    expect(await inOrganisation("SELECT venue FROM conferences WHERE code = 'IT'")).toEqual([
      { venue: 'Beograd' },
    ]);
  });

  describe('the first admin', () => {
    let token = '';

    it('refuses a list of addresses or an address with a name', async () => {
      for (const email of ['a@example.test, b@example.test', 'Ana <ana@example.test>']) {
        const result = await firstAdmin(['--email', email, '--name', 'Ana']);
        expect(result.exitCode).toBe(2);
      }
      expect(await inOrganisation('SELECT id FROM users')).toEqual([]);
    });

    it('creates an invitation only and prints its link once, to the terminal', async () => {
      const result = await firstAdmin(['--email', ADMIN_EMAIL, '--name', 'Prva Administratorka']);
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: '',
      });
      const links = [
        ...result.stdout.matchAll(
          /https:\/\/admin\.confera\.test\/invitations\/([A-Za-z0-9_-]{43})/g,
        ),
      ];
      expect(links).toHaveLength(1);
      token = links[0]?.[1] ?? '';

      const users = await inOrganisation<{
        id: string;
        status: string;
        password_hash: string | null;
        role: string;
      }>(
        `SELECT u.id, u.status, u.password_hash, r.role FROM users u JOIN user_roles r ON r.user_id = u.id`,
      );
      expect(users).toEqual([
        expect.objectContaining({ status: 'invited', password_hash: null, role: 'admin' }),
      ]);
      // The database keeps the SHA-256 of the token, never the token.
      const stored = await inOrganisation<{ token_hash: string; purpose: string }>(
        'SELECT token_hash, purpose FROM secure_links',
      );
      expect(stored).toEqual([{ token_hash: digestOf(token), purpose: 'invitation' }]);
      const everything = JSON.stringify(
        await inOrganisation(
          `SELECT (SELECT json_agg(a) FROM audit_entries a) AS audit, (SELECT json_agg(m) FROM mail_outbox m) AS outbox`,
        ),
      );
      expect(everything).not.toContain(token);
    });

    it('a second run while still invited makes a new link and ends the first', async () => {
      const result = await firstAdmin(['--email', ADMIN_EMAIL, '--name', 'Prva Administratorka']);
      expect(result.exitCode).toBe(0);
      const second = /\/invitations\/([A-Za-z0-9_-]{43})/.exec(result.stdout)?.[1] ?? '';
      const links = await inOrganisation<{ token_hash: string; revoked: boolean }>(
        'SELECT token_hash, revoked_at IS NOT NULL AS revoked FROM secure_links ORDER BY created_at',
      );
      expect(links).toEqual([
        { token_hash: digestOf(token), revoked: true },
        { token_hash: digestOf(second), revoked: false },
      ]);
      token = second;
    });

    it('the application starts and stays healthy with no mail server, and the link works there; nothing logs it', async () => {
      e2e = await startE2eApp(e2eEnvironment({ MAIL_WORKER_INTERVAL_SECONDS: '1' }));
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect((await e2e.http().get('/health')).status).toBe(200);
      const opened = await e2e.admin(`/api/v1/invitations/${token}`);
      expect(opened.status).toBe(200);
      const accepted = await e2e
        .http()
        .post(`/api/v1/invitations/${token}`)
        .set('Host', ADMIN_HOST)
        .set('Origin', e2e.config.origins.admin)
        .send({
          password: 'invented-Breza-Most-Polje-7',
          passwordRepeat: 'invented-Breza-Most-Polje-7',
        });
      expect(accepted.status).toBeLessThan(300);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await e2e.http().get('/health')).status).toBe(200);
      expect(e2e.logText()).not.toContain(token);
    });

    it('refuses once the organisation has an active admin', async () => {
      const result = await firstAdmin([
        '--email',
        'druga.osoba@udekom.example.test',
        '--name',
        'Druga Osoba',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('has an active admin already');
      expect(await inOrganisation('SELECT id FROM users')).toHaveLength(1);
    });
  });
});
