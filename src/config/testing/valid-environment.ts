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

/**
 * A complete, valid environment of a server (STAGE=prod, production instance). A staging
 * instance needs its mail catcher too: `validStagingEnvironment`.
 */
export function validProductionEnvironment(overrides: RawEnvironment = {}): TestEnvironment {
  return {
    ...validEnvironment(),
    STAGE: 'prod',
    INSTANCE: 'production',
    FILE_STORAGE_DIR: '/var/lib/confera/files',
    CLAMAV_ADDRESS: 'clamav.confera.test:3310',
    ADMIN_ORIGIN: 'https://admin.confera.test',
    PUBLIC_ORIGIN: 'https://forms.confera.test',
    ...overrides,
  };
}

/** A complete, valid environment of the staging server: its mail goes to the catcher (ST-50). */
export function validStagingEnvironment(overrides: RawEnvironment = {}): TestEnvironment {
  return validProductionEnvironment({
    INSTANCE: 'staging',
    STAGING_MAIL_CATCHER: 'mailpit.confera.test:1025',
    ...overrides,
  });
}
