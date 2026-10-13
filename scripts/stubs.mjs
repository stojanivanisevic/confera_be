// `pnpm stubs`: the stub slot of the development stack (ADR-24, M1-QA-02).
//
//   corepack pnpm stubs
//
// The place where the stand-ins for outside services run on a developer machine: the
// PayPal stub arrives with 0.7.0, the fixture rate provider with 0.5.0. In 0.1.0 the
// slot is EMPTY: it starts, says that it is up and which stubs it holds (none), and
// answers everything else "not found". What exists already is the part the end-to-end
// stack depends on: one documented command, one port, one way to see that it is up.
//
// A TEST TOOL, never part of a build (dist/ and dist-dev/ do not contain it):
// - it refuses to run unless STAGE is local, dev or test (exit code 78);
// - it listens on 127.0.0.1 only, never on a public address;
// - it reads no request body and logs no header.
//
// Port: STUBS_PORT, default 4010. Stop it with Ctrl+C.
import { createServer } from 'node:http';
import { requireStage } from './lib/stage.mjs';

const TOOL = 'stubs';
const STUB_STAGES = ['local', 'dev', 'test'];
const DEFAULT_PORT = 4010;
const HOST = '127.0.0.1';

/** The stubs this slot holds. A stub is added here in the milestone that needs it. */
const STUBS = [];

function port() {
  const value = process.env.STUBS_PORT;
  if (value === undefined || value === '') {
    return DEFAULT_PORT;
  }
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
    process.stderr.write(
      `${TOOL} did not run:\n  - STUBS_PORT: must be a whole number between 1 and 65535\n`,
    );
    process.exit(78);
  }
  return Number(value);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const stage = requireStage(TOOL, STUB_STAGES);
const listenPort = port();

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://${HOST}`);
  req.resume();
  if (req.method === 'GET' && pathname === '/health') {
    send(res, 200, { status: 'ok', stubs: STUBS.map(({ name }) => name) });
    return;
  }
  send(res, 404, { code: 'no_stub' });
});

server.on('error', (error) => {
  process.stderr.write(
    `${TOOL} did not run: cannot listen on ${HOST}:${String(listenPort)} (${error.code ?? 'no error code'}). Is another one still running?\n`,
  );
  process.exit(1);
});

server.listen(listenPort, HOST, () => {
  process.stdout.write(
    `${TOOL}: the stub slot listens on http://${HOST}:${String(listenPort)} (STAGE=${stage}); stubs: ${
      STUBS.length === 0 ? 'none yet' : STUBS.map(({ name }) => name).join(', ')
    }\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Open keep-alive connections must not keep the tool alive.
    server.closeAllConnections();
  });
}
