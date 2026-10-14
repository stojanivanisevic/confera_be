import { createServer, connect as connectSocket, type Server, type Socket } from 'node:net';
import { freePort } from '../support/api-process';
import { type E2eApp, e2eEnvironment, startE2eApp } from './support/e2e-app';
import { e2eDatabase } from './support/e2e-database';

/**
 * Edge case found by the edge-case hunter (M1-REV-01): the database HANGS while the
 * application runs. It does not go away; it stops answering, with every connection still
 * open: a database that is overloaded, paused, swapping, or behind a network that drops
 * packets instead of refusing them. (database-outage.spec.ts covers the database that
 * goes away, whose connections are closed and refused at once.)
 *
 * The expectation is the one the test engineer wrote for an outage, unchanged: readiness
 * says 503 in the one error format within a few seconds, and the routes that need no
 * database keep answering. A readiness check that hangs instead holds a connection of the
 * pool for as long as the database hangs, and the probe in front of the API sees no
 * answer at all instead of "not ready".
 *
 * The application reaches PostgreSQL through a relay that the test can freeze: while it
 * is frozen it keeps every connection open, accepts new ones, and delivers nothing in
 * either direction. Thawing delivers what was held, in order.
 */

interface FreezingRelay {
  readonly port: number;
  freeze(): void;
  thaw(): void;
  close(): Promise<void>;
}

async function startFreezingRelay(targetHost: string, targetPort: number): Promise<FreezingRelay> {
  const port = await freePort();
  const sockets = new Set<Socket>();
  let frozen = false;
  let held: (() => void)[] = [];

  const forward = (from: Socket, to: Socket): void => {
    from.on('data', (chunk: Buffer) => {
      const deliver = () => {
        if (!to.destroyed) {
          to.write(chunk);
        }
      };
      if (frozen) {
        held.push(deliver);
      } else {
        deliver();
      }
    });
  };

  const server: Server = createServer((client) => {
    const upstream = connectSocket(targetPort, targetHost);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    }
    forward(client, upstream);
    forward(upstream, client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port,
    freeze: () => {
      frozen = true;
    },
    thaw: () => {
      frozen = false;
      const waiting = held;
      held = [];
      for (const deliver of waiting) {
        deliver();
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}

function through(relayPort: number, address: string): string {
  const url = new URL(address);
  url.hostname = '127.0.0.1';
  url.port = String(relayPort);
  return url.toString();
}

/** The status of a GET, or 'no answer' when none came within `ms`. */
async function statusWithin(
  ask: () => PromiseLike<{ status: number }> & { timeout(ms: number): unknown },
  ms: number,
): Promise<number | 'no answer'> {
  try {
    const request = ask();
    request.timeout(ms);
    return (await request).status;
  } catch {
    return 'no answer';
  }
}

describe('edge case (M1-REV-01): the database hangs while the application runs', () => {
  jest.setTimeout(180_000);

  let relay: FreezingRelay;
  let e2e: E2eApp;

  beforeAll(async () => {
    const target = new URL(e2eDatabase.applicationUrl);
    relay = await startFreezingRelay(target.hostname, Number(target.port || 5432));
    e2e = await startE2eApp(
      e2eEnvironment({
        DATABASE_URL: through(relay.port, e2eDatabase.applicationUrl),
        SYSTEM_DATABASE_URL: through(relay.port, e2eDatabase.systemUrl),
      }),
    );
  });

  afterAll(async () => {
    // Thaw first, so that whatever still waits for the database can finish and the
    // application can close its pools.
    relay.thaw();
    await e2e.close();
    await relay.close();
  });

  it('first of all it is ready: the relay carries the connection', async () => {
    expect((await e2e.admin('/health/ready')).status).toBe(200);
  });

  describe('while the database hangs', () => {
    beforeAll(() => {
      relay.freeze();
    });

    it('readiness answers 503 within a few seconds, as it does when the database is gone', async () => {
      const started = Date.now();
      const status = await statusWithin(() => e2e.admin('/health/ready'), 20_000);
      expect({ status, withinFifteenSeconds: Date.now() - started < 15_000 }).toEqual({
        status: 503,
        withinFifteenSeconds: true,
      });
    });

    it('liveness and the routes that need no database keep answering', async () => {
      expect(await statusWithin(() => e2e.admin('/health'), 5_000)).toBe(200);
      expect(await statusWithin(() => e2e.admin('/api/v1/meta'), 5_000)).toBe(200);
    });
  });

  describe('when the database answers again', () => {
    beforeAll(() => {
      relay.thaw();
    });

    it('readiness is ok again without a restart of the application', async () => {
      const deadline = Date.now() + 30_000;
      let status: number | 'no answer' = 'no answer';
      while (Date.now() < deadline) {
        status = await statusWithin(() => e2e.admin('/health/ready'), 5_000);
        if (status === 200) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(status).toBe(200);
    });
  });
});
