import { inspect } from 'node:util';
import { type ConfigProblem, formatProblems, parseEnvironment } from './config';
import {
  DEFAULT_PORT,
  SECRET_VARIABLE_NAMES,
  VARIABLE_NAMES,
  VARIABLES,
  type VariableName,
} from './config.schema';
import { validEnvironment } from './testing/valid-environment';

function problemsOf(env: Record<string, string | undefined>): readonly ConfigProblem[] {
  const result = parseEnvironment(env);
  return result.ok ? [] : result.problems;
}

function variablesWithProblems(env: Record<string, string | undefined>): string[] {
  return problemsOf(env).map((problem) => problem.variable);
}

describe('configuration', () => {
  it('accepts a complete, valid environment', () => {
    const result = parseEnvironment(validEnvironment());
    expect(result.ok).toBe(true);
  });

  it('maps the variables to the typed configuration', () => {
    const result = parseEnvironment(validEnvironment({ PORT: '4321', LOG_LEVEL: 'warn' }));
    if (!result.ok) {
      throw new Error('expected a valid configuration');
    }
    expect(result.config.stage).toBe('test');
    expect(result.config.http.port).toBe(4321);
    expect(result.config.origins).toEqual({
      admin: 'http://admin.confera.test',
      public: 'http://forms.confera.test',
    });
    expect(result.config.logLevel).toBe('warn');
    expect(result.config.database.applicationUrl.reveal()).toContain('confera_app');
    expect(result.config.database.systemUrl.reveal()).toContain('confera_system');
  });

  it('uses the documented defaults for the optional variables', () => {
    const result = parseEnvironment(validEnvironment({ PORT: undefined }));
    if (!result.ok) {
      throw new Error('expected a valid configuration');
    }
    expect(result.config.http.port).toBe(DEFAULT_PORT);
    expect(result.config.http.listenHost).toBe('127.0.0.1');
    expect(result.config.logLevel).toBe('info');
  });

  describe('a missing variable stops the start and is named', () => {
    const required = VARIABLE_NAMES.filter((name) => VARIABLES[name].required);

    it('knows which variables are required', () => {
      expect(required).toEqual(
        expect.arrayContaining(['STAGE', 'ADMIN_ORIGIN', 'PUBLIC_ORIGIN', 'DATABASE_URL']),
      );
    });

    it.each(required)('%s', (name: VariableName) => {
      expect(variablesWithProblems(validEnvironment({ [name]: undefined }))).toContain(name);
    });

    it.each(required)('%s given as an empty string', (name: VariableName) => {
      expect(variablesWithProblems(validEnvironment({ [name]: '' }))).toContain(name);
    });

    it('reports every problem of an empty environment at once', () => {
      expect(variablesWithProblems({})).toEqual(expect.arrayContaining(required));
    });
  });

  describe('an invalid value stops the start and is named', () => {
    it.each<[VariableName, string]>([
      ['PORT', '0'],
      ['PORT', '65536'],
      ['PORT', '3001x'],
      ['PORT', '-1'],
      ['PORT', '3001.5'],
      ['LISTEN_HOST', 'not a host'],
      ['ADMIN_ORIGIN', 'admin.confera.test'],
      ['ADMIN_ORIGIN', 'http://admin.confera.test/'],
      ['ADMIN_ORIGIN', 'http://admin.confera.test/path'],
      ['ADMIN_ORIGIN', 'http://user:pw@admin.confera.test'],
      ['ADMIN_ORIGIN', 'ftp://admin.confera.test'],
      ['ADMIN_ORIGIN', 'HTTP://ADMIN.CONFERA.TEST'],
      ['PUBLIC_ORIGIN', 'http://forms.confera.test?x=1'],
      ['DATABASE_URL', 'mysql://confera_app:pw@127.0.0.1:3306/confera'],
      ['DATABASE_URL', 'postgresql://127.0.0.1:5432/confera'],
      ['DATABASE_URL', 'postgresql://confera_app@127.0.0.1:5432/confera'],
      ['DATABASE_URL', 'postgresql://confera_app:pw@127.0.0.1:5432'],
      ['SYSTEM_DATABASE_URL', 'not a url'],
      ['LOG_LEVEL', 'verbose'],
      ['LOG_LEVEL', 'INFO'],
    ])('%s=%s', (name, value) => {
      expect(variablesWithProblems(validEnvironment({ [name]: value }))).toEqual([name]);
    });
  });

  describe('STAGE has no default and exact values (ADR-24, ST-01)', () => {
    it.each(['local', 'dev', 'test', 'prod'])('knows the value %s', (stage) => {
      const problems = problemsOf(validEnvironment({ STAGE: stage }));
      expect(problems.filter((p) => p.problem.includes('must be exactly one of'))).toEqual([]);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['the long word', 'production'],
      ['upper case', 'PROD'],
      ['a trailing space', 'prod '],
      ['a leading space', ' prod'],
      ['a trailing line break', 'prod\n'],
      ['mixed case', 'Local'],
      ['another word', 'staging'],
      ['a list', 'local,prod'],
    ])('refuses %s', (_name, value) => {
      expect(variablesWithProblems(validEnvironment({ STAGE: value }))).toContain('STAGE');
    });
  });

  describe('secrets', () => {
    it('marks the database addresses as secret', () => {
      expect(SECRET_VARIABLE_NAMES).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'SYSTEM_DATABASE_URL']),
      );
    });

    it('never repeats a value in a problem message', () => {
      const canary = 'canary-7d1e44';
      const env = validEnvironment();
      for (const name of VARIABLE_NAMES) {
        env[name] = `${canary}-${name}`;
      }
      const result = parseEnvironment(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(formatProblems(result.problems)).not.toContain(canary);
        expect(JSON.stringify(result.problems)).not.toContain(canary);
      }
    });

    it('does not show a secret when the configuration is printed', () => {
      const canary = 'canary-51b0aa';
      const result = parseEnvironment(
        validEnvironment({
          DATABASE_URL: `postgresql://confera_app:${canary}@127.0.0.1:5432/confera_unit`,
          SYSTEM_DATABASE_URL: `postgresql://confera_system:${canary}@127.0.0.1:5432/confera_unit`,
        }),
      );
      if (!result.ok) {
        throw new Error('expected a valid configuration');
      }
      expect(JSON.stringify(result.config)).not.toContain(canary);
      expect(inspect(result.config, { depth: 10 })).not.toContain(canary);
    });

    it('has no variable named like a password or a master key (ST-09)', () => {
      // No code can compare a password with a configuration value when the
      // configuration holds no such value. Credentials of services are stored
      // encrypted in the database, never in the environment (ADR-11).
      for (const name of VARIABLE_NAMES) {
        expect(name).not.toMatch(/PASSWORD|PASSWD|MASTER/);
      }
    });
  });

  describe('formatProblems', () => {
    it('prints one line per variable and points at .env.example', () => {
      const text = formatProblems([
        { variable: 'STAGE', problem: 'is required' },
        { variable: 'PORT', problem: 'must be a number' },
      ]);
      expect(text).toContain('  - STAGE: is required');
      expect(text).toContain('  - PORT: must be a number');
      expect(text).toContain('.env.example');
    });
  });
});
