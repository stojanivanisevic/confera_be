import { createServer, type Server, type Socket } from 'node:net';
import type { AppConfig } from '../../config/config';
import { MailTransport } from './mail-transport';

/**
 * E2-06 (ADR-13: "a hanging server never holds the worker", the comment of TIMEOUT_MS): the
 * three timeouts of the transport are timeouts of INACTIVITY. A host that answers a little
 * every few seconds never trips one, so one delivery can last for ever. The worker takes
 * the messages of every organisation one after the other, so one organisation's mail server
 * can hold up the mail of all, and the test message of a server holds its HTTP request.
 */
describe('a delivery through a host that answers slowly (E2-06)', () => {
  jest.setTimeout(90_000);

  let server: Server;
  const sockets = new Set<Socket>();
  const drips: NodeJS.Timeout[] = [];
  let port = 0;

  beforeAll(async () => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      socket.write('220 tarpit.example.test ESMTP\r\n');
      let answering = false;
      socket.on('data', () => {
        if (answering) {
          return;
        }
        answering = true;
        // A multi-line answer that never ends, one line every 5 seconds: well inside each
        // 15-second timeout.
        const drip = setInterval(() => socket.write('250-x\r\n'), 5000);
        drips.push(drip);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    drips.forEach(clearInterval);
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('is given up after a total time that does not depend on the server', async () => {
    const transport = new MailTransport({ stage: 'test' } as AppConfig);
    const started = Date.now();
    const outcome = await Promise.race([
      transport
        .deliver(
          {
            host: '127.0.0.1',
            port,
            tlsMode: 'none',
            username: null,
            password: null,
            fromAddress: 'office@a.example.test',
            fromName: 'Ured',
          },
          { to: 'mila@a.example.test', subject: 'Proba', html: '<p>Proba</p>', text: 'Proba' },
        )
        .then((result) => ({ result, took: Date.now() - started })),
      new Promise<{ result: 'still_running'; took: number }>((resolve) =>
        setTimeout(() => {
          resolve({ result: 'still_running', took: Date.now() - started });
        }, 60_000),
      ),
    ]);
    // A delivery is over, one way or the other, within a minute (15 s per step, a few steps).
    expect(outcome.result).not.toBe('still_running');
  });
});
