import { Module, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { configureHttp } from '../../bootstrap';
import { type AppConfig, parseEnvironment, type RawEnvironment } from '../../config/config';
import { validEnvironment } from '../../config/testing/valid-environment';
import { DatabaseRoleCheck } from '../../platform/prisma/database-role-check';
import { AppLogger, createRootLogger } from '../logging/app-logger';

export interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

export interface TestApp {
  readonly app: NestExpressApplication;
  readonly config: AppConfig;
  /** Every log entry written so far, parsed. */
  logs(): LogEntry[];
  /** Everything written to the log so far, as text. */
  logText(): string;
  close(): Promise<void>;
}

export const ADMIN_HOST = 'admin.confera.test';
export const PUBLIC_HOST = 'forms.confera.test';

export function configFrom(env: RawEnvironment): AppConfig {
  const result = parseEnvironment(env);
  if (!result.ok) {
    throw new Error(`test configuration is not valid: ${JSON.stringify(result.problems)}`);
  }
  return result.config;
}

/**
 * The real application module with the middleware of the entries, for unit tests of the
 * HTTP layer: extra controllers for the test, the log captured in memory, and NO
 * database. The start-up role check is replaced by a no-op here and only here; the
 * tests that need a database are the integration tests, which start the built
 * application unchanged.
 */
export async function createTestApp(
  options: { env?: RawEnvironment; controllers?: Type[] } = {},
): Promise<TestApp> {
  const config = configFrom(options.env ?? validEnvironment({ LOG_LEVEL: 'debug' }));
  let text = '';
  const logger = new AppLogger(
    createRootLogger(config.logLevel, { write: (chunk: string) => void (text += chunk) }),
  );

  @Module({ controllers: options.controllers ?? [] })
  class TestControllersModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register({ config, logger, extraImports: [TestControllersModule] })],
  })
    .overrideProvider(DatabaseRoleCheck)
    .useValue({})
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useLogger(logger);
  configureHttp(app, logger);
  await app.init();

  return {
    app,
    config,
    logText: () => text,
    logs: () =>
      text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogEntry),
    close: () => app.close(),
  };
}
