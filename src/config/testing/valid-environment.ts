import type { RawEnvironment } from '../config';

type TestEnvironment = Record<string, string | undefined>;

/**
 * A complete, valid environment of a developer machine (STAGE=test) for tests. The
 * credentials are invented and point at nothing; tests that need a database take theirs
 * from the test harness instead.
 */
export function validEnvironment(overrides: RawEnvironment = {}): TestEnvironment {
  return {
    STAGE: 'test',
    PORT: '3001',
    ADMIN_ORIGIN: 'http://admin.confera.test',
    PUBLIC_ORIGIN: 'http://forms.confera.test',
    DATABASE_URL: 'postgresql://confera_app:invented-app-password@127.0.0.1:5432/confera_unit',
    SYSTEM_DATABASE_URL:
      'postgresql://confera_system:invented-system-password@127.0.0.1:5432/confera_unit',
    DATA_KEY: 'invented-data-key-of-the-unit-tests-0123456789ab',
    ...overrides,
  };
}

/** A complete, valid environment of a server (STAGE=prod, staging instance). */
export function validProductionEnvironment(overrides: RawEnvironment = {}): TestEnvironment {
  return {
    ...validEnvironment(),
    STAGE: 'prod',
    INSTANCE: 'staging',
    ADMIN_ORIGIN: 'https://admin.confera.test',
    PUBLIC_ORIGIN: 'https://forms.confera.test',
    ...overrides,
  };
}
