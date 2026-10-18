import { type ConfigProblem, parseEnvironment } from './config';
import { DEV_PREFIX, DEV_VARIABLE_NAMES, INSTANCES, STAGES, VARIABLE_NAMES } from './config.schema';
import { isLoopbackOrTestHost, TOOL_ONLY_VARIABLES } from './stage-guard';
import {
  validEnvironment,
  validProductionEnvironment,
  validStagingEnvironment,
} from './testing/valid-environment';

type Env = Record<string, string | undefined>;

function problemsOf(env: Env): readonly ConfigProblem[] {
  const result = parseEnvironment(env);
  return result.ok ? [] : result.problems;
}

function refused(env: Env): string[] {
  return problemsOf(env).map((problem) => problem.variable);
}

function accepted(env: Env): boolean {
  return parseEnvironment(env).ok;
}

const NON_PRODUCTION = ['local', 'dev', 'test'] as const;

describe('STAGE and INSTANCE guard (ADR-24)', () => {
  it('accepts the valid environments these tests start from', () => {
    expect(problemsOf(validEnvironment())).toEqual([]);
    expect(problemsOf(validProductionEnvironment())).toEqual([]);
    expect(problemsOf(validStagingEnvironment())).toEqual([]);
  });

  describe('non-production stages run only on a developer machine (ST-01)', () => {
    const publicOrigins = [
      'https://admin.udekom.example',
      'http://admin.example.org',
      'https://confera.rs',
      'http://192.168.1.20:3000',
      'http://10.0.0.5:3000',
      'http://0.0.0.0:3000',
      'http://test:3000',
      'http://localhost.example.org',
      'http://127.0.0.1.example.org',
      'http://example.test.org',
    ];

    describe.each(NON_PRODUCTION)('STAGE=%s', (stage) => {
      it.each(publicOrigins)('refuses the admin origin %s', (origin) => {
        expect(refused(validEnvironment({ STAGE: stage, ADMIN_ORIGIN: origin }))).toEqual([
          'ADMIN_ORIGIN',
        ]);
      });

      it.each(publicOrigins)('refuses the public origin %s', (origin) => {
        expect(refused(validEnvironment({ STAGE: stage, PUBLIC_ORIGIN: origin }))).toEqual([
          'PUBLIC_ORIGIN',
        ]);
      });

      it.each([
        ['http://localhost:3000', 'http://127.0.0.1:3000'],
        ['http://admin.localhost:3000', 'http://forms.localhost:3000'],
        ['http://admin.confera.test', 'http://forms.confera.test'],
        ['https://admin.confera.test:8443', 'https://forms.confera.test:8443'],
        ['http://[::1]:3000', 'http://localhost:3000'],
        ['http://127.0.0.2:3000', 'http://127.0.0.1:3000'],
      ])('accepts %s with %s', (admin, publicOrigin) => {
        expect(
          accepted(
            validEnvironment({ STAGE: stage, ADMIN_ORIGIN: admin, PUBLIC_ORIGIN: publicOrigin }),
          ),
        ).toBe(true);
      });
    });
  });

  describe('INSTANCE (ST-01)', () => {
    it.each(INSTANCES)('accepts %s on prod', (instance) => {
      const result = parseEnvironment(
        instance === 'staging'
          ? validStagingEnvironment()
          : validProductionEnvironment({ INSTANCE: instance }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.instance).toBe(instance);
      }
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['the short word', 'prod'],
      ['upper case', 'PRODUCTION'],
      ['capitalised', 'Staging'],
      ['a trailing space', 'staging '],
      ['a typing mistake', 'stagin'],
      ['another word', 'live'],
      ['a stage name', 'test'],
    ])('stops the start on prod when it is %s', (_name, value) => {
      expect(refused(validProductionEnvironment({ INSTANCE: value }))).toEqual(['INSTANCE']);
    });

    it.each(NON_PRODUCTION)('must not be set on STAGE=%s', (stage) => {
      expect(refused(validEnvironment({ STAGE: stage, INSTANCE: 'staging' }))).toEqual([
        'INSTANCE',
      ]);
      expect(refused(validEnvironment({ STAGE: stage, INSTANCE: 'production' }))).toEqual([
        'INSTANCE',
      ]);
    });

    it('is null in the configuration of a developer machine', () => {
      const result = parseEnvironment(validEnvironment());
      expect(result.ok && result.config.instance).toBeNull();
    });
  });

  describe('the staging mail redirect (ADR-27, ST-50)', () => {
    it('is required on a staging instance', () => {
      for (const value of [undefined, '']) {
        expect([
          ...new Set(refused(validStagingEnvironment({ STAGING_MAIL_CATCHER: value }))),
        ]).toEqual(['STAGING_MAIL_CATCHER']);
      }
    });

    it('is refused on a production instance', () => {
      expect(refused(validProductionEnvironment({ STAGING_MAIL_CATCHER: 'mailpit:1025' }))).toEqual(
        ['STAGING_MAIL_CATCHER'],
      );
    });

    it.each(NON_PRODUCTION)('is refused on STAGE=%s', (stage) => {
      expect(
        refused(validEnvironment({ STAGE: stage, STAGING_MAIL_CATCHER: '127.0.0.1:1025' })),
      ).toEqual(['STAGING_MAIL_CATCHER']);
    });

    it('must be host:port', () => {
      for (const value of ['mailpit', 'smtp://mailpit:1025', 'mailpit:0', 'mail pit:1025']) {
        expect(refused(validStagingEnvironment({ STAGING_MAIL_CATCHER: value }))).toEqual([
          'STAGING_MAIL_CATCHER',
        ]);
      }
    });

    it('is in the configuration of staging only', () => {
      const staging = parseEnvironment(validStagingEnvironment());
      expect(staging.ok && staging.config.mail.stagingCatcher).toEqual({
        host: 'mailpit.confera.test',
        port: 1025,
      });
      const production = parseEnvironment(validProductionEnvironment());
      expect(production.ok && production.config.mail.stagingCatcher).toBeNull();
    });
  });

  describe('DEV_ conveniences (ST-04)', () => {
    it('the schema knows at least one DEV_ key, and each starts with the prefix', () => {
      expect(DEV_VARIABLE_NAMES.length).toBeGreaterThan(0);
      for (const name of VARIABLE_NAMES) {
        expect(DEV_VARIABLE_NAMES.includes(name)).toBe(name.startsWith(DEV_PREFIX));
      }
    });

    describe.each(DEV_VARIABLE_NAMES)('%s', (name) => {
      it.each(['local', 'dev'])('is accepted on STAGE=%s', (stage) => {
        expect(accepted(validEnvironment({ STAGE: stage, [name]: 'true' }))).toBe(true);
        expect(accepted(validEnvironment({ STAGE: stage, [name]: 'false' }))).toBe(true);
      });

      it.each(['true', 'false', '', '1'])('stops the start on prod, even set to "%s"', (value) => {
        expect(refused(validProductionEnvironment({ [name]: value }))).toContain(name);
      });

      it('stops the start on test', () => {
        expect(refused(validEnvironment({ STAGE: 'test', [name]: 'true' }))).toEqual([name]);
      });

      it.each(['yes', '1', 'TRUE', ''])('accepts only true or false, not "%s"', (value) => {
        expect(refused(validEnvironment({ STAGE: 'local', [name]: value }))).toEqual([name]);
      });
    });

    describe.each(STAGES)('an unknown DEV_ variable on STAGE=%s', (stage) => {
      const base =
        stage === 'prod' ? validProductionEnvironment() : validEnvironment({ STAGE: stage });

      it.each(['DEV_LOGIN', 'DEV_MASTER_PASSWORD', 'DEV_API_DOC', 'DEV_'])(
        'stops the start: %s',
        (name) => {
          expect(refused({ ...base, [name]: 'true' })).toContain(name);
          expect(refused({ ...base, [name]: '' })).toContain(name);
        },
      );
    });

    it('refuses an unknown DEV_ variable even when STAGE itself is missing', () => {
      expect(refused(validEnvironment({ STAGE: undefined, DEV_LOGIN: 'true' }))).toEqual(
        expect.arrayContaining(['STAGE', 'DEV_LOGIN']),
      );
    });

    it('leaves the conveniences off when no key is set', () => {
      const result = parseEnvironment(validEnvironment({ STAGE: 'local' }));
      expect(result.ok && result.config.devTools).toEqual({ apiDocs: false, logQueries: false });
    });

    it('does not mind variables with other prefixes', () => {
      expect(accepted(validProductionEnvironment({ DEVICE: 'x', NODE_ENV: 'production' }))).toBe(
        true,
      );
    });
  });

  describe('prod is a positive allowlist', () => {
    it.each(['http://admin.confera.test', 'http://localhost:3000'])(
      'requires https: %s',
      (origin) => {
        expect(refused(validProductionEnvironment({ ADMIN_ORIGIN: origin }))).toEqual([
          'ADMIN_ORIGIN',
        ]);
      },
    );

    it.each(['debug', 'trace'])('refuses LOG_LEVEL=%s', (level) => {
      expect(refused(validProductionEnvironment({ LOG_LEVEL: level }))).toEqual(['LOG_LEVEL']);
    });

    it.each(['fatal', 'error', 'warn', 'info'])('accepts LOG_LEVEL=%s', (level) => {
      expect(accepted(validProductionEnvironment({ LOG_LEVEL: level }))).toBe(true);
    });

    it.each(TOOL_ONLY_VARIABLES)('refuses the tool credential %s in the API', (name) => {
      expect(refused(validProductionEnvironment({ [name]: 'anything' }))).toEqual([name]);
    });

    it.each(TOOL_ONLY_VARIABLES)('allows %s on a developer machine', (name) => {
      expect(accepted(validEnvironment({ STAGE: 'local', [name]: 'anything' }))).toBe(true);
    });

    it('listens on every address inside its container, and only locally elsewhere', () => {
      const prod = parseEnvironment(validProductionEnvironment());
      const local = parseEnvironment(validEnvironment({ STAGE: 'local' }));
      expect(prod.ok && prod.config.http.listenHost).toBe('0.0.0.0');
      expect(local.ok && local.config.http.listenHost).toBe('127.0.0.1');
    });
  });

  describe('two surfaces, two host names (ADR-02)', () => {
    it.each([
      ['http://localhost:3000', 'http://localhost:3001'],
      ['http://admin.confera.test', 'http://admin.confera.test:8080'],
    ])('refuses %s with %s', (admin, publicOrigin) => {
      expect(
        refused(validEnvironment({ ADMIN_ORIGIN: admin, PUBLIC_ORIGIN: publicOrigin })),
      ).toEqual(['PUBLIC_ORIGIN']);
    });
  });

  describe('isLoopbackOrTestHost', () => {
    it.each([
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '[::1]',
      'a.localhost',
      'x.y.test',
    ])('true for %s', (host) => {
      expect(isLoopbackOrTestHost(host)).toBe(true);
    });

    it.each(['test', 'example.org', 'localhost.org', '128.0.0.1', '10.0.0.1', '0.0.0.0', 'atest'])(
      'false for %s',
      (host) => {
        expect(isLoopbackOrTestHost(host)).toBe(false);
      },
    );
  });

  it('never repeats a value in a message', () => {
    const canary = 'canary-a81f02';
    const env = validProductionEnvironment({
      INSTANCE: canary,
      LOG_LEVEL: `${canary}-level`,
      DEV_LOGIN: canary,
      DEV_API_DOCS: canary,
      MIGRATION_DATABASE_URL: `postgresql://confera_owner:${canary}@db.confera.test:5432/confera`,
      ADMIN_ORIGIN: `http://${canary}.confera.test`,
    });
    expect(JSON.stringify(problemsOf(env))).not.toContain(canary);
  });
});
