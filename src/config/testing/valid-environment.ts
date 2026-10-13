import type { RawEnvironment } from '../config';

/**
 * A complete, valid environment for tests. The credentials are invented and point at
 * nothing; tests that need a database take theirs from the test harness instead.
 */
export function validEnvironment(
  overrides: RawEnvironment = {},
): Record<string, string | undefined> {
  return {
    STAGE: 'test',
    PORT: '3001',
    ADMIN_ORIGIN: 'http://admin.confera.test',
    PUBLIC_ORIGIN: 'http://forms.confera.test',
    DATABASE_URL: 'postgresql://confera_app:invented-app-password@127.0.0.1:5432/confera_unit',
    SYSTEM_DATABASE_URL:
      'postgresql://confera_system:invented-system-password@127.0.0.1:5432/confera_unit',
    ...overrides,
  };
}
