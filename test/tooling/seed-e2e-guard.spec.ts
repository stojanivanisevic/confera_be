import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';

/**
 * `pnpm seed:e2e` refuses to run outside the stages `local` and `test` (M1-QA-02,
 * ADR-24: "`seed:e2e` refuses to run outside local and test").
 *
 * Here without a database, so it runs in `pnpm check`. The owner address points at a
 * port where nothing listens: a seed that tried to connect would end with exit code 1
 * and "cannot connect". Exit code 78 therefore proves that the refusal comes FIRST,
 * before a connection is opened. test/e2e/seed.spec.ts repeats it against a real
 * database and counts the rows.
 */

const SEED = join('scripts', 'seed-e2e.mjs');
const EXIT_CONFIGURATION = 78;
const NOWHERE = 'postgresql://confera_owner:invented-nowhere@127.0.0.1:1/confera';

const run = (env: Record<string, string | undefined>) =>
  runNode([SEED], { env: { MIGRATION_DATABASE_URL: NOWHERE, ...env }, timeoutMs: 30_000 });

describe('seed:e2e refuses to run outside local and test', () => {
  jest.setTimeout(60_000);

  it.each([
    ['prod', 'prod'],
    ['dev', 'dev'],
    ['unset', undefined],
    ['empty', ''],
    ['the long word', 'production'],
    ['staging', 'staging'],
    ['upper case', 'LOCAL'],
    ['capitalised', 'Test'],
    ['a trailing space', 'local '],
    ['a leading space', ' test'],
    ['two stages', 'local,prod'],
    ['a stage that only starts like one', 'testing'],
  ])('STAGE %s', async (_name, stage) => {
    const result = await run({ STAGE: stage });
    expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({
      exitCode: EXIT_CONFIGURATION,
      stdout: '',
    });
    expect(result.stderr).toContain('seed:e2e did not run');
    expect(result.stderr).toContain('runs only on STAGE=local or test');
    expect(result.stderr).toContain('  - STAGE: ');
    expect(result.stderr).not.toContain('cannot connect');
  });

  it('on a server: STAGE=prod with INSTANCE and a full configuration is refused all the same', async () => {
    for (const instance of ['production', 'staging']) {
      const result = await run({
        STAGE: 'prod',
        INSTANCE: instance,
        ADMIN_ORIGIN: 'https://admin.confera.test',
        PUBLIC_ORIGIN: 'https://forms.confera.test',
      });
      expect(result.exitCode).toBe(EXIT_CONFIGURATION);
      expect(result.stderr).not.toContain('cannot connect');
    }
  });

  it('no other variable can talk it into running', async () => {
    const result = await run({
      STAGE: 'prod',
      SEED_E2E: 'true',
      FORCE: 'true',
      CI: 'true',
      NODE_ENV: 'test',
      DEV_SEED: 'true',
    });
    expect(result.exitCode).toBe(EXIT_CONFIGURATION);
  });

  it('takes no command-line switch that lifts the refusal', async () => {
    for (const flag of ['--force', '--yes', '--stage=test', '--allow-prod']) {
      const result = await runNode([SEED, flag], {
        env: { STAGE: 'prod', MIGRATION_DATABASE_URL: NOWHERE },
      });
      expect(result.exitCode).toBe(EXIT_CONFIGURATION);
    }
  });

  it('never repeats a value in its refusal', async () => {
    const canary = 'canary-5eed-91';
    const result = await run({
      STAGE: canary,
      MIGRATION_DATABASE_URL: `postgresql://confera_owner:${canary}@db.confera.test:5432/confera`,
    });
    expect(result.exitCode).toBe(EXIT_CONFIGURATION);
    expect(result.output).not.toContain(canary);
  });

  describe('the control: on an allowed stage it goes on, to the database', () => {
    it.each(['local', 'test'])(
      'STAGE=%s tries to connect, and says so when nothing answers',
      async (stage) => {
        const result = await run({ STAGE: stage });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('seed:e2e failed: cannot connect to PostgreSQL');
        expect(result.output).not.toContain('invented-nowhere');
      },
    );

    it('names the missing owner address', async () => {
      const result = await runNode([SEED], { env: { STAGE: 'test' } });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MIGRATION_DATABASE_URL is not set');
    });
  });

  describe('how it is started', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    it('is the script seed:e2e of package.json, which reads STAGE from .env and nothing else', () => {
      expect(manifest.scripts['seed:e2e']).toBe(
        'node --env-file-if-exists=.env scripts/seed-e2e.mjs',
      );
    });

    it('a STAGE of the environment wins over the one in .env: a server stays refused', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'confera-seed-env-'));
      try {
        const envFile = join(directory, '.env');
        writeFileSync(envFile, `STAGE=local\nMIGRATION_DATABASE_URL=${NOWHERE}\n`);
        const onServer = await runNode([`--env-file-if-exists=${envFile}`, SEED], {
          env: { STAGE: 'prod' },
        });
        expect(onServer.exitCode).toBe(EXIT_CONFIGURATION);
        // The control: without a stage in the environment the file's stage is used.
        const onDeveloperMachine = await runNode([`--env-file-if-exists=${envFile}`, SEED]);
        expect(onDeveloperMachine.exitCode).toBe(1);
        expect(onDeveloperMachine.stderr).toContain('cannot connect to PostgreSQL');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('is documented in the README', () => {
      const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
      expect(readme).toContain('corepack pnpm seed:e2e');
      expect(readme).toMatch(/seed:e2e[^\n]*refuses/i);
    });

    it('sets no stage of its own: the script and its helper hold no default', () => {
      for (const file of [SEED, join('scripts', 'lib', 'stage.mjs')]) {
        const text = readFileSync(join(repoRoot, file), 'utf8');
        expect(text).not.toMatch(/process\.env\.STAGE\s*(\?\?|\|\||=[^=])/);
        expect(text).not.toMatch(/STAGE\s*:\s*['"]/);
      }
    });
  });
});
