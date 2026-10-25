// The fake clamd of the development stack (M4 Blank-slate, after M3-ISS-01): a stand-in for
// ClamAV's daemon that speaks the part of its protocol the API uses, so that uploaded files and
// email images become clean on a developer machine and the real client is what talks to it.
//
//   corepack pnpm stack:up                 starts it in Docker with the stack (service fake-clamd)
//   corepack pnpm stack:clamd              runs it in this terminal instead (Ctrl+C stops it)
//   node scripts/fake-clamd.mjs --ping     asks a running one for PONG (the health check)
//
// What it answers, like the test double test/support/fake-clamd.ts in its mode `clean`:
// - zINSTREAM: `stream: OK`, unless the stream holds the EICAR test string, which is
//   `stream: Eicar-Signature FOUND`;
// - zPING: `PONG`;
// - zVERSION: a version line that names it as this fake (FAKE_CLAMD_VERSION). The topology
//   check of a server asks ClamAV for its version and refuses this answer;
// - anything else: `UNKNOWN COMMAND`.
//
// A TEST TOOL, never on a server:
// - it refuses to run unless STAGE is local, dev or test (exit code 78), or, in the container
//   of docker-compose.yml, which hands no STAGE to anything, with --in-development-stack; on
//   STAGE=prod it refuses whatever it is given. The production
//   topology (deploy/compose.yml) runs the real ClamAV image; the API on STAGE=prod refuses the
//   address of this service (src/config/stage-guard.ts), and no image holds this file
//   (.dockerignore is an allowlist);
// - it listens on 127.0.0.1 unless FAKE_CLAMD_HOST says otherwise (the container of the stack
//   listens on its own interface; Docker publishes the port on 127.0.0.1 only);
// - it finds nothing but EICAR. Never point anything at it that needs a real scan.
//
// Plain Node and self-contained (no import of this repository): the stack mounts this one file
// into a Node container.
import { connect, createServer } from 'node:net';

const TOOL = 'fake-clamd';
const ALLOWED_STAGES = ['local', 'dev', 'test'];
const EXIT_CONFIGURATION = 78;
const EICAR = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';
/** The version line; deploy/checks/topology.mjs refuses a scanner that answers with it. */
const FAKE_CLAMD_VERSION = 'ClamAV 0.0.0-confera-fake-clamd/0/development stack only';
/** At most this much of a stream is kept: the API sends at most 51 MB. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

function refuse(lines) {
  process.stderr.write([`${TOOL} did not run:`, ...lines.map((l) => `  - ${l}`), ''].join('\n'));
  process.exit(EXIT_CONFIGURATION);
}

function portOf(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
    refuse(['FAKE_CLAMD_PORT: must be a whole number between 1 and 65535']);
  }
  return Number(value);
}

/** clamd's answer to one stream. */
function answerOf(content) {
  return content.includes(EICAR) ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0';
}

/** Serves one connection: one command (z-prefixed, NUL-terminated), one answer. */
function serve(socket) {
  let buffer = Buffer.alloc(0);
  let command = null;
  const chunks = [];
  let kept = 0;
  socket.setTimeout(130_000, () => socket.destroy());
  socket.on('error', () => undefined);
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (command === null) {
      const end = buffer.indexOf(0);
      if (end < 0) {
        if (buffer.length > 64) socket.end('UNKNOWN COMMAND\0');
        return;
      }
      command = buffer.subarray(0, end).toString('latin1');
      buffer = buffer.subarray(end + 1);
      if (command === 'zPING') {
        socket.end('PONG\0');
        return;
      }
      if (command === 'zVERSION') {
        socket.end(`${FAKE_CLAMD_VERSION}\0`);
        return;
      }
      if (command !== 'zINSTREAM') {
        socket.end('UNKNOWN COMMAND\0');
        return;
      }
    }
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length === 0) {
        socket.end(answerOf(Buffer.concat(chunks)));
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < 4 + length) {
        return;
      }
      kept += length;
      if (kept > MAX_STREAM_BYTES) {
        socket.end('INSTREAM size limit exceeded. ERROR\0');
        return;
      }
      chunks.push(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
    }
  });
}

/** The health check: exit 0 when a fake clamd answers PONG on the port. */
function ping(port) {
  const socket = connect({ host: '127.0.0.1', port, timeout: 3000 });
  let answer = '';
  socket.on('connect', () => socket.write('zPING\0'));
  socket.on('data', (data) => (answer += data.toString('latin1')));
  socket.on('end', () => process.exit(answer.replace(/\0/g, '').trim() === 'PONG' ? 0 : 1));
  socket.on('timeout', () => process.exit(1));
  socket.on('error', () => process.exit(1));
}

function main() {
  const stage = process.env.STAGE;
  const inStack = process.argv.includes('--in-development-stack') && stage === undefined;
  if (!inStack && (stage === undefined || !ALLOWED_STAGES.includes(stage))) {
    refuse([
      `STAGE: is missing or has another value; it is a test tool and runs only on STAGE=${ALLOWED_STAGES.join(' or ')}`,
    ]);
  }
  const port = portOf(process.env.FAKE_CLAMD_PORT, 3310);
  if (process.argv.includes('--ping')) {
    ping(port);
  } else {
    const host = process.env.FAKE_CLAMD_HOST || '127.0.0.1';
    const server = createServer(serve);
    server.on('error', (error) => {
      process.stderr.write(
        `${TOOL} did not start: ${error.code ?? error.message} on ${host}:${port}\n`,
      );
      process.exit(1);
    });
    server.listen(port, host, () => {
      process.stdout.write(
        `${TOOL} listens on ${host}:${port}: every stream is clean but the EICAR test string. Development only.\n`,
      );
    });
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}

main();
