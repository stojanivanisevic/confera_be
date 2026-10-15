import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { repoRoot } from './run-node';

/**
 * A minimal SMTP server for tests of the transport (ST-20, ST-23): it answers the commands
 * a client sends for one message and records them. Plain, or TLS from the first byte with
 * a certificate the test made itself (self-signed: a client that verifies refuses it).
 * `offerStartTls: false` is a server that offers no TLS at all.
 */
export interface FakeSmtpSession {
  readonly commands: string[];
  readonly recipients: string[];
  data: string;
}

export interface FakeSmtp {
  readonly port: number;
  readonly sessions: FakeSmtpSession[];
  close(): Promise<void>;
}

function serve(socket: Socket, sessions: FakeSmtpSession[]): void {
  const session: FakeSmtpSession = { commands: [], recipients: [], data: '' };
  sessions.push(session);
  let buffer = '';
  let inData = false;
  socket.setEncoding('utf8');
  socket.write('220 fake.example.test ESMTP\r\n');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) {
          return;
        }
        session.data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write('250 2.0.0 queued\r\n');
        continue;
      }
      const end = buffer.indexOf('\r\n');
      if (end < 0) {
        return;
      }
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      session.commands.push(line);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') {
        socket.write('250-fake.example.test\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
      } else if (verb === 'HELO') {
        socket.write('250 fake.example.test\r\n');
      } else if (verb === 'MAIL') {
        socket.write('250 2.1.0 ok\r\n');
      } else if (verb === 'RCPT') {
        session.recipients.push(/<([^>]*)>/.exec(line)?.[1] ?? line);
        socket.write('250 2.1.5 ok\r\n');
      } else if (verb === 'DATA') {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (verb === 'QUIT') {
        socket.end('221 bye\r\n');
      } else if (verb === 'RSET' || verb === 'NOOP') {
        socket.write('250 ok\r\n');
      } else {
        socket.write('502 not implemented\r\n');
      }
    }
  });
  socket.on('error', () => undefined);
}

async function listen(server: Server, sessions: FakeSmtpSession[]): Promise<FakeSmtp> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    sessions,
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

/** A plain SMTP server that offers no STARTTLS. */
export function startPlainSmtp(): Promise<FakeSmtp> {
  const sessions: FakeSmtpSession[] = [];
  return listen(
    createServer((socket) => {
      serve(socket, sessions);
    }),
    sessions,
  );
}

/** The openssl of this machine: on the path, or the one of Git for Windows. */
function openssl(): string | null {
  for (const candidate of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe']) {
    if (candidate !== 'openssl' && !existsSync(candidate)) {
      continue;
    }
    if (spawnSync(candidate, ['version'], { encoding: 'utf8' }).status === 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * A self-signed certificate for localhost, made now under tmp/ and removed at once: no
 * key is ever in the repository.
 */
export function selfSignedCertificate(): { key: string; cert: string } {
  const tool = openssl();
  if (tool === null) {
    throw new Error('openssl is needed for the self-signed certificate of ST-20');
  }
  const folder = mkdtempSync(join(repoRoot, 'tmp', 'smtp-cert-'));
  try {
    const result = spawnSync(
      tool,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        join(folder, 'key.pem'),
        '-out',
        join(folder, 'cert.pem'),
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(`openssl failed: ${result.stderr}`);
    }
    return {
      key: readFileSync(join(folder, 'key.pem'), 'utf8'),
      cert: readFileSync(join(folder, 'cert.pem'), 'utf8'),
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** An SMTP server with TLS from the first byte and a self-signed certificate. */
export function startSelfSignedSmtp(): Promise<FakeSmtp> {
  const sessions: FakeSmtpSession[] = [];
  const server = createTlsServer(selfSignedCertificate(), (socket) => {
    serve(socket, sessions);
  });
  return listen(server, sessions);
}
