import { Module, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../../bootstrap';
import { type AppConfig, parseEnvironment, type RawEnvironment } from '../../config/config';
import { validEnvironment } from '../../config/testing/valid-environment';

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
 * The real application (same middleware, filter, guard and pipe as the entries), with
 * extra controllers for the test and with the log captured in memory.
 */
export async function createTestApp(
  options: { env?: RawEnvironment; controllers?: Type[] } = {},
): Promise<TestApp> {
  const config = configFrom(options.env ?? validEnvironment({ LOG_LEVEL: 'debug' }));
  let text = '';

  @Module({ controllers: options.controllers ?? [] })
  class TestControllersModule {}

  const app = await createApp(config, {
    extraImports: [TestControllersModule],
    logDestination: { write: (chunk: string) => void (text += chunk) },
  });
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
