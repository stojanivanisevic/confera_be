import { createServer, connect as connectSocket, type Server, type Socket } from 'node:net';
import { freePort } from '../support/api-process';
import { type E2eApp, e2eEnvironment, startE2eApp } from './support/e2e-app';
import { e2eDatabase } from './support/e2e-database';

/**
 * The database goes away while the application runs, and comes back (edge case of M1:
 * "database unreachable"; at start it is covered by test/integration/database-roles).
 *
 * The application under test reaches PostgreSQL through a small TCP relay that the test
 * can cut and restore, so nothing else that uses the database is disturbed.
 *
 * Expected: liveness and the routes that need no database keep answering; readiness
 * says 503 in the one error format; no address and no password reach a response or the
 * log; the process survives; and readiness is ok again as soon as the database is back,
 * without a restart.
 */

interface Relay {
  readonly port: number;
  /** Closes the listening socket and every open connection: the database is "gone". */
  cut(): Promise<void>;
  /** Listens again on the same port: the database is "back". */
  restore(): Promise<void>;
  close(): Promise<void>;
}

async function startRelay(targetHost: string, targetPort: number): Promise<Relay> {
  const port = await freePort();
  const sockets = new Set<Socket>();
  let server: Server | undefined;

  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const created = createServer((client) => {
        const upstream = connectSocket(targetPort, targetHost);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on('error', () => undefined);
          socket.on('close', () => sockets.delete(socket));
        }
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      created.on('error', reject);
      created.listen(port, '127.0.0.1', () => {
        server = created;
        resolve();
      });
    });

  const cut = (): Promise<void> =>
    new Promise((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server === undefined) {
        resolve();
        return;
      }
      const closing = server;
      server = undefined;
      closing.close(() => {
        resolve();
      });
    });

  await listen();
  return { port, cut, restore: listen, close: cut };
}

function through(relayPort: number, address: string): string {
  const url = new URL(address);
  url.hostname = '127.0.0.1';
  url.port = String(relayPort);
  return url.toString();
}

describe('the database goes away while the application runs', () => {
  jest.setTimeout(180_000);

  let relay: Relay;
  let e2e: E2eApp;
  const passwords = (): string[] =>
    [e2eDatabase.applicationUrl, e2eDatabase.systemUrl].map((address) => new URL(address).password);

  beforeAll(async () => {
    const target = new URL(e2eDatabase.applicationUrl);
    relay = await startRelay(target.hostname, Number(target.port || 5432));
    e2e = await startE2eApp(
      e2eEnvironment({
        DATABASE_URL: through(relay.port, e2eDatabase.applicationUrl),
        SYSTEM_DATABASE_URL: through(relay.port, e2eDatabase.systemUrl),
      }),
    );
  });

  afterAll(async () => {
    await e2e.close();
    await relay.close();
  });

  it('first of all it is ready: the relay carries the connection', async () => {
    expect((await e2e.admin('/health/ready')).status).toBe(200);
  });

  describe('while the database is gone', () => {
    beforeAll(async () => {
      await relay.cut();
    });

    it('readiness answers 503 in the one error format, within a few seconds', async () => {
      const started = Date.now();
      const response = await e2e.admin('/health/ready');
      expect(response.status).toBe(503);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.body).toEqual({
        code: 'service_unavailable',
        title: 'Service Unavailable',
        status: 503,
        traceId: expect.any(String),
      });
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it('liveness and the routes that need no database keep answering', async () => {
      expect((await e2e.admin('/health')).status).toBe(200);
      expect((await e2e.admin('/api/v1/meta')).status).toBe(200);
      expect((await e2e.public('/api/v1/meta')).status).toBe(404);
    });

    it('twenty readiness checks at once are each answered 503, none hangs', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => e2e.admin('/health/ready')),
      );
      expect(responses.map((response) => response.status)).toEqual(
        Array.from({ length: 20 }, () => 503),
      );
    });

    it('no response and no log line shows an address or a password', async () => {
      const response = await e2e.admin('/health/ready');
      for (const forbidden of [...passwords(), 'postgresql://', 'ECONNREFUSED', '127.0.0.1']) {
        expect(response.text).not.toContain(forbidden);
      }
      for (const password of passwords()) {
        expect(e2e.logText()).not.toContain(password);
      }
      expect(e2e.logText()).not.toContain('postgresql://');
    });
  });

  describe('when the database is back', () => {
    beforeAll(async () => {
      await relay.restore();
    });

    it('readiness is ok again without a restart of the application', async () => {
      const deadline = Date.now() + 30_000;
      let status = 0;
      while (Date.now() < deadline) {
        status = (await e2e.admin('/health/ready')).status;
        if (status === 200) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(status).toBe(200);
    });

    it('and it stays ok', async () => {
      for (let index = 0; index < 5; index += 1) {
        expect((await e2e.admin('/health/ready')).status).toBe(200);
      }
    });
  });
});
