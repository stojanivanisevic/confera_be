import { createServer, type Server, type Socket } from 'node:net';
import { validProductionEnvironment } from '../../src/config/testing/valid-environment';
import { freePort, PRODUCTION_ENTRY } from '../support/api-process';
import { runNode } from '../support/run-node';

/**
 * Edge case found by the edge-case hunter (M1-REV-01): the database HANGS at start.
 *
 * database-roles.spec.ts proves that a start against a database that cannot be reached
 * ends with exit code 77 and one sentence: a wrong password, a missing role or database,
 * and "a server that does not answer", which there is a closed port (refused at once).
 * A database can also accept the connection and then say nothing: a paused or overloaded
 * server, a port forwarder whose target is gone (Docker's own forwarder does this when
 * the container is paused), a network that drops packets. The README promises the same
 * outcome for "no database": exit code 77 (section 4) and the sentence of section 14. A
 * start that waits for ever instead is a container that runs, never listens and never
 * says why.
 */

const EXIT_REFUSED = 77;

/** A TCP server that accepts every connection and never sends a byte. */
async function silentServer(): Promise<{ port: number; close(): Promise<void> }> {
  const port = await freePort();
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
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

describe('edge case (M1-REV-01): the database accepts the connection and never answers at start', () => {
  jest.setTimeout(120_000);

  let silent: { port: number; close(): Promise<void> };

  beforeAll(async () => {
    silent = await silentServer();
  });

  afterAll(async () => {
    await silent.close();
  });

  it('the built API refuses to start with exit code 77 and the sentence of the README, within a minute', async () => {
    const at = (role: string): string => {
      const url = new URL('postgresql://confera_app:invented-silent@127.0.0.1:5432/confera');
      url.username = role;
      url.port = String(silent.port);
      return url.toString();
    };
    const result = await runNode([PRODUCTION_ENTRY], {
      env: {
        ...validProductionEnvironment(),
        DATABASE_URL: at('confera_app'),
        SYSTEM_DATABASE_URL: at('confera_system'),
        PORT: String(await freePort()),
        LISTEN_HOST: '127.0.0.1',
      },
      timeoutMs: 60_000,
    });
    expect({ exitCode: result.exitCode, timedOut: result.timedOut }).toEqual({
      exitCode: EXIT_REFUSED,
      timedOut: false,
    });
    expect(result.stderr).toContain('The database cannot be reached with DATABASE_URL');
    expect(result.output).not.toContain('api.started');
    expect(result.output).not.toContain('invented-silent');
  });
});
