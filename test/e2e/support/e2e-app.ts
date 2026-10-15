import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from '../../../src/bootstrap';
import { type AppConfig, parseEnvironment, type RawEnvironment } from '../../../src/config/config';
import {
  validEnvironment,
  validProductionEnvironment,
} from '../../../src/config/testing/valid-environment';
import { e2eDatabase } from './e2e-database';

/**
 * The application under test: the REAL application (`createApp` of src/bootstrap.ts, the
 * function both entries use), with nothing replaced and nothing added. It runs its
 * start-up role check and talks to PostgreSQL as the application role, so every request
 * of a test goes through row-level security exactly as on a server (ADR-24).
 *
 * The only things a test decides are the environment (by default the one of a server,
 * `STAGE=prod`) and where the log goes (into memory, so a test can read it).
 */

export const ADMIN_HOST = 'admin.confera.test';
export const PUBLIC_HOST = 'forms.confera.test';

export interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

export interface E2eApp {
  readonly app: NestExpressApplication;
  readonly config: AppConfig;
  /** Where the application listens: http://127.0.0.1:<a free port>. */
  readonly baseUrl: string;
  /** A supertest agent on the application. Set the Host header yourself. */
  http(): ReturnType<typeof request>;
  /** GET under the admin host name. */
  admin(path: string): request.Test;
  /** GET under the public host name. */
  public(path: string): request.Test;
  /** Every log entry written so far, parsed. */
  logs(): LogEntry[];
  /** Everything written to the log so far, as text. */
  logText(): string;
  close(): Promise<void>;
}

/** The environment of a server whose two database roles are the ones of the test database. */
export function e2eEnvironment(overrides: RawEnvironment = {}): Record<string, string | undefined> {
  return {
    ...validProductionEnvironment(),
    DATABASE_URL: e2eDatabase.applicationUrl,
    SYSTEM_DATABASE_URL: e2eDatabase.systemUrl,
    // The outbox worker runs when a test calls its tick, not on a timer of its own.
    MAIL_WORKER_INTERVAL_SECONDS: '0',
    ...overrides,
  };
}

/** The environment of a developer machine (STAGE=test) on the test database. */
export function e2eLocalEnvironment(
  overrides: RawEnvironment = {},
): Record<string, string | undefined> {
  return {
    ...validEnvironment(),
    DATABASE_URL: e2eDatabase.applicationUrl,
    SYSTEM_DATABASE_URL: e2eDatabase.systemUrl,
    MAIL_WORKER_INTERVAL_SECONDS: '0',
    ...overrides,
  };
}

export async function startE2eApp(env: RawEnvironment = e2eEnvironment()): Promise<E2eApp> {
  const parsed = parseEnvironment(env);
  if (!parsed.ok) {
    throw new Error(`e2e configuration is not valid: ${JSON.stringify(parsed.problems)}`);
  }
  const { config } = parsed;

  let text = '';
  const app = await createApp(config, {
    logDestination: { write: (chunk: string) => void (text += chunk) },
  });
  // A real socket on a free port of the loopback address: requests travel as they do on
  // a server, and many requests at once share one listening server.
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  const http = () => request(baseUrl);
  return {
    app,
    config,
    baseUrl,
    http,
    admin: (path) => http().get(path).set('Host', ADMIN_HOST),
    public: (path) => http().get(path).set('Host', PUBLIC_HOST),
    logText: () => text,
    logs: () =>
      text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogEntry),
    close: () => app.close(),
  };
}
