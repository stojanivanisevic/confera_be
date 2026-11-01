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
    ADMIN_ORIGIN: 'http://admin.congresa.test',
    PUBLIC_ORIGIN: 'http://forms.congresa.test',
    DATABASE_URL: 'postgresql://congresa_app:invented-app-password@127.0.0.1:5432/congresa_unit',
    SYSTEM_DATABASE_URL:
      'postgresql://congresa_system:invented-system-password@127.0.0.1:5432/congresa_unit',
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
    FILE_STORAGE_DIR: '/var/lib/congresa/files',
    CLAMAV_ADDRESS: 'clamav.congresa.test:3310',
    ADMIN_ORIGIN: 'https://admin.congresa.test',
    PUBLIC_ORIGIN: 'https://forms.congresa.test',
    ...overrides,
  };
}

/** A complete, valid environment of the staging server: its mail goes to the catcher (ST-50). */
export function validStagingEnvironment(overrides: RawEnvironment = {}): TestEnvironment {
  return validProductionEnvironment({
    INSTANCE: 'staging',
    STAGING_MAIL_CATCHER: 'mailpit.congresa.test:1025',
    ...overrides,
  });
}
