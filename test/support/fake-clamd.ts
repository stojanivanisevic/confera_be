import { createServer, type Server, type Socket } from 'node:net';

/**
 * A stand-in for the ClamAV daemon in the tests (M3-BE-08): it speaks clamd's INSTREAM
 * command on a port of the loopback address, so the real client of the API is what is
 * tested. The development stack has no ClamAV (it needs about 1.2 GB of memory and a
 * signature download); the production image brings the real one (0.4.0).
 *
 * - `clean`: every stream is OK, unless it holds the EICAR string, which is FOUND;
 * - `limits`: every stream exceeds the scanner's limits;
 * - `silent`: it accepts the connection and never answers (a hung daemon);
 * - `error`: it answers with an error.
 */
export type FakeClamdMode = 'clean' | 'limits' | 'silent' | 'error';

export interface FakeClamd {
  readonly address: string;
  mode: FakeClamdMode;
  /** Streams it was asked to scan so far. */
  scans: number;
  close(): Promise<void>;
}

function answer(mode: FakeClamdMode, content: Buffer): string | null {
  switch (mode) {
    case 'silent':
      return null;
    case 'error':
      return "stream: Can't allocate memory ERROR\0";
    case 'limits':
      return 'INSTREAM size limit exceeded. ERROR\0';
    default:
      return content.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
        ? 'stream: Eicar-Signature FOUND\0'
        : 'stream: OK\0';
  }
}

export async function startFakeClamd(mode: FakeClamdMode = 'clean'): Promise<FakeClamd> {
  const sockets = new Set<Socket>();
  const fake: FakeClamd = {
    address: '',
    mode,
    scans: 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => { resolve(); });
      }),
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let commandRead = false;
    const chunks: Buffer[] = [];
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (!commandRead) {
        const end = buffer.indexOf(0);
        if (end < 0) {
          return;
        }
        commandRead = buffer.subarray(0, end).toString() === 'zINSTREAM';
        buffer = buffer.subarray(end + 1);
        if (!commandRead) {
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          fake.scans += 1;
          const reply = answer(fake.mode, Buffer.concat(chunks));
          buffer = Buffer.alloc(0);
          if (reply !== null) {
            socket.end(reply);
          }
          return;
        }
        if (buffer.length < 4 + length) {
          return;
        }
        chunks.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return Object.assign(fake, { address: `127.0.0.1:${String(port)}` });
}
