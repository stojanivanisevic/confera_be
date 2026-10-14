import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEV_VARIABLE_NAMES, SECRET_VARIABLE_NAMES } from '../../src/config/config.schema';
import { TOOL_ONLY_VARIABLES } from '../../src/config/stage-guard';
import {
  validEnvironment,
  validProductionEnvironment,
} from '../../src/config/testing/valid-environment';
import { DEVELOPMENT_ENTRY, freePort, PRODUCTION_ENTRY } from '../support/api-process';
import { repoRoot, runNode } from '../support/run-node';

/**
 * ST-01, ST-04 and the configuration part of ST-03, on the BUILT application: the process
 * started with `node dist/main.js` refuses to start, with exit code 78, and names the
 * variable. Needs `pnpm build` and `pnpm build:dev`; `pnpm check` runs both first.
 */

type Env = Record<string, string | undefined>;

const EXIT_CONFIGURATION = 78;

interface Refusal {
  readonly exitCode: number | null;
  readonly output: string;
  readonly stdout: string;
}

/** Starts an entry and waits for it to end. A process that keeps running is killed and reported. */
async function start(entry: string, env: Env): Promise<Refusal> {
  // A free port, so that a start that wrongly succeeds cannot collide with anything.
  const port = String(await freePort());
  const result = await runNode([entry], {
    env: { PORT: port, LISTEN_HOST: '127.0.0.1', ...env },
    timeoutMs: 20_000,
  });
  return { exitCode: result.exitCode, output: result.output, stdout: result.stdout };
}

function expectRefusal(result: Refusal, ...variables: string[]): void {
  expect({ exitCode: result.exitCode, output: result.output }).toEqual({
    exitCode: EXIT_CONFIGURATION,
    output: expect.stringContaining('Confera API did not start'),
  });
  for (const variable of variables) {
    expect(result.output).toContain(`  - ${variable}: `);
  }
  // Nothing of the application ran: no log line, and nothing at all on stdout.
  expect(result.output).not.toContain('api.started');
  expect(result.stdout).toBe('');
}

describe('the built application refuses to start on a bad stage (ADR-24)', () => {
  jest.setTimeout(60_000);

  beforeAll(() => {
    for (const entry of [PRODUCTION_ENTRY, DEVELOPMENT_ENTRY]) {
      if (!existsSync(join(repoRoot, entry))) {
        throw new Error(`${entry} is missing: run "corepack pnpm build" and "build:dev" first`);
      }
    }
  });

  describe('STAGE has no default and exact values (ST-01)', () => {
    it.concurrent.each([
      ['unset', undefined],
      ['empty', ''],
      ['the long word', 'production'],
      ['upper case', 'PROD'],
      ['a trailing space', 'prod '],
      ['a stage that does not exist', 'staging'],
    ])('STAGE %s', async (_name, value) => {
      expectRefusal(
        await start(PRODUCTION_ENTRY, validProductionEnvironment({ STAGE: value })),
        'STAGE',
      );
    });

    it('an empty environment names every required variable', async () => {
      expectRefusal(
        await start(PRODUCTION_ENTRY, {}),
        'STAGE',
        'ADMIN_ORIGIN',
        'PUBLIC_ORIGIN',
        'DATABASE_URL',
        'SYSTEM_DATABASE_URL',
      );
    });
  });

  describe('a non-production stage on a public origin (ST-01)', () => {
    it.concurrent.each(['local', 'dev', 'test'])('STAGE=%s', async (stage) => {
      const result = await start(
        PRODUCTION_ENTRY,
        validEnvironment({
          STAGE: stage,
          ADMIN_ORIGIN: 'https://admin.udekom.example',
          PUBLIC_ORIGIN: 'https://forms.udekom.example',
        }),
      );
      expectRefusal(result, 'ADMIN_ORIGIN', 'PUBLIC_ORIGIN');
    });
  });

  describe('INSTANCE on a prod stage (ST-01)', () => {
    it.concurrent.each([
      ['missing', undefined],
      ['empty', ''],
      ['misspelt', 'stagin'],
      ['the short word', 'prod'],
      ['capitalised', 'Production'],
    ])('INSTANCE %s', async (_name, value) => {
      expectRefusal(
        await start(PRODUCTION_ENTRY, validProductionEnvironment({ INSTANCE: value })),
        'INSTANCE',
      );
    });
  });

  describe('DEV_ keys, taken from the schema itself (ST-04)', () => {
    it('the schema has DEV_ keys to test', () => {
      expect(DEV_VARIABLE_NAMES.length).toBeGreaterThan(0);
    });

    it.concurrent.each(
      DEV_VARIABLE_NAMES.flatMap((name): [string, string][] => [
        [name, 'true'],
        [name, 'false'],
      ]),
    )('prod with %s=%s', async (name, value) => {
      expectRefusal(
        await start(PRODUCTION_ENTRY, validProductionEnvironment({ [name]: value })),
        name,
      );
    });

    it.concurrent.each(DEV_VARIABLE_NAMES)('test with %s=true', async (name) => {
      expectRefusal(
        await start(PRODUCTION_ENTRY, validEnvironment({ STAGE: 'test', [name]: 'true' })),
        name,
      );
    });

    it.concurrent.each([
      ['prod', 'DEV_LOGIN'],
      ['prod', 'DEV_MASTER_PASSWORD'],
      ['test', 'DEV_LOGIN'],
      ['local', 'DEV_LOGIN'],
      ['dev', 'DEV_ANYTHING'],
    ])('an unknown DEV_ variable on %s: %s', async (stage, name) => {
      const base =
        stage === 'prod' ? validProductionEnvironment() : validEnvironment({ STAGE: stage });
      expectRefusal(await start(PRODUCTION_ENTRY, { ...base, [name]: 'true' }), name);
    });
  });

  describe('prod is a positive allowlist (ST-04)', () => {
    it.concurrent.each(TOOL_ONLY_VARIABLES)('a tool credential in the API: %s', async (name) => {
      expectRefusal(
        await start(PRODUCTION_ENTRY, validProductionEnvironment({ [name]: 'anything' })),
        name,
      );
    });

    it('debug logging', async () => {
      expectRefusal(
        await start(PRODUCTION_ENTRY, validProductionEnvironment({ LOG_LEVEL: 'debug' })),
        'LOG_LEVEL',
      );
    });

    it('an origin without https', async () => {
      expectRefusal(
        await start(
          PRODUCTION_ENTRY,
          validProductionEnvironment({ PUBLIC_ORIGIN: 'http://forms.confera.test' }),
        ),
        'PUBLIC_ORIGIN',
      );
    });
  });

  describe('the development entry', () => {
    it.concurrent.each(['test', 'prod'])('refuses STAGE=%s', async (stage) => {
      const base =
        stage === 'prod' ? validProductionEnvironment() : validEnvironment({ STAGE: stage });
      expectRefusal(await start(DEVELOPMENT_ENTRY, base), 'STAGE');
    });
  });

  describe('a refused start prints no value (ST-03)', () => {
    it('with a canary in every variable', async () => {
      const canary = 'canary-c4d91e7a';
      const env: Env = validProductionEnvironment({
        INSTANCE: `${canary}-instance`,
        LOG_LEVEL: `${canary}-level`,
        ADMIN_ORIGIN: `http://${canary}.confera.test`,
        DEV_LOGIN: `${canary}-dev`,
        MIGRATION_DATABASE_URL: `postgresql://confera_owner:${canary}@db.confera.test:5432/confera`,
      });
      for (const name of SECRET_VARIABLE_NAMES) {
        env[name] = `${canary}-${name}`;
      }
      const result = await start(PRODUCTION_ENTRY, env);
      expectRefusal(result, 'INSTANCE', 'DEV_LOGIN', ...SECRET_VARIABLE_NAMES);
      expect(result.output).not.toContain(canary);
    });
  });

  describe('a refused start ends before the application is loaded', () => {
    // test/support/loaded-modules.cjs says, when the process ends, what it had loaded.
    // A refusal that first loads the framework and every module costs ten times as much,
    // and on a busy machine the many starts of this file then run into their time limit.
    const PROBE = join(repoRoot, 'test', 'support', 'loaded-modules.cjs');

    async function loadedBy(entry: string, env: Env, timeoutMs: number) {
      const port = String(await freePort());
      const result = await runNode(['--require', PROBE, entry], {
        env: { PORT: port, LISTEN_HOST: '127.0.0.1', ...env },
        timeoutMs,
      });
      return {
        exitCode: result.exitCode,
        loaded: /^LOADED .*$/m.exec(result.stdout)?.[0] ?? result.output,
      };
    }

    it.each([
      ['production', PRODUCTION_ENTRY, validProductionEnvironment({ STAGE: 'production' })],
      ['development', DEVELOPMENT_ENTRY, validProductionEnvironment()],
    ])(
      'the %s entry reads the configuration and nothing of the application',
      async (_name, entry, env) => {
        expect(await loadedBy(entry, env, 20_000)).toEqual({
          exitCode: EXIT_CONFIGURATION,
          loaded: 'LOADED configuration=true application=false',
        });
      },
    );

    it('control: a start that the configuration allows does load the application', async () => {
      // A valid configuration whose database is not there: the start goes on, loads the
      // application, fails at the database and ends by itself.
      // Written out in full, with an invented password on the loopback address: the form
      // the secret scan accepts (README, section 12).
      const result = await loadedBy(
        PRODUCTION_ENTRY,
        validEnvironment({
          DATABASE_URL: 'postgresql://confera_app:invented-nowhere@127.0.0.1:1/confera_unit',
          SYSTEM_DATABASE_URL:
            'postgresql://confera_system:invented-nowhere@127.0.0.1:1/confera_unit',
        }),
        150_000,
      );
      expect(result.loaded).toBe('LOADED configuration=true application=true');
      expect(result.exitCode).not.toBe(EXIT_CONFIGURATION);
      expect(result.exitCode).not.toBe(0);
      // The one start of this file that loads the whole application: it gets the time.
    }, 180_000);
  });
});
