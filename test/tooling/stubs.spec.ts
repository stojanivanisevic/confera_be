import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { freePort, send } from '../support/api-process';
import { baseEnvironment, repoRoot, runNode } from '../support/run-node';

/**
 * `pnpm stubs`: the stub slot of the development stack (M1-QA-02, ADR-24). Empty in
 * 0.1.0. What is tested is what the end-to-end stack depends on already: the documented
 * command starts it, it says that it is up, it listens on the developer machine only,
 * and it refuses to run on a server.
 */

const STUBS = join('scripts', 'stubs.mjs');
const EXIT_CONFIGURATION = 78;

interface RunningStubs {
  readonly port: number;
  output(): string;
  stop(): Promise<number | null>;
}

async function startStubs(stage: string): Promise<RunningStubs> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [STUBS], {
    cwd: repoRoot,
    env: { ...baseEnvironment(), STAGE: stage, STUBS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited: number | null | undefined;
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const closed = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      exited = code;
      resolve(code);
    });
  });

  const deadline = Date.now() + 20_000;
  while (!output.includes('the stub slot listens on')) {
    if (exited !== undefined) {
      throw new Error(`the stub slot ended with exit code ${String(exited)}:\n${output}`);
    }
    if (Date.now() > deadline) {
      child.kill();
      await closed;
      throw new Error(`the stub slot did not start within 20 s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    port,
    output: () => output,
    async stop() {
      child.kill();
      return closed;
    },
  };
}

/** Resolves true when a TCP connection to the address is accepted. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

describe('the stub slot (pnpm stubs)', () => {
  jest.setTimeout(60_000);

  describe.each(['local', 'dev', 'test'])('on STAGE=%s', (stage) => {
    let stubs: RunningStubs;

    beforeAll(async () => {
      stubs = await startStubs(stage);
    });

    afterAll(async () => {
      await stubs.stop();
    });

    it('starts and says where it listens and which stubs it holds', () => {
      expect(stubs.output()).toContain(
        `stubs: the stub slot listens on http://127.0.0.1:${String(stubs.port)} (STAGE=${stage}); stubs: none yet`,
      );
    });

    it('GET /health answers ok with the list of stubs, which is empty in 0.1.0', async () => {
      const response = await send(stubs.port, '/health');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(JSON.parse(response.text)).toEqual({ status: 'ok', stubs: [] });
    });

    it.each([
      ['GET', '/'],
      ['GET', '/v2/checkout/orders'],
      ['POST', '/health'],
      ['POST', '/v1/oauth2/token'],
      ['GET', '/health/../../package.json'],
      ['GET', '/.env'],
    ])('%s %s is not found: an empty slot stands in for nothing', async (method, path) => {
      const response = await send(stubs.port, path, { method, body: '{"secret":"x"}' });
      expect(response.status).toBe(404);
      expect(JSON.parse(response.text)).toEqual({ code: 'no_stub' });
    });

    it('carries no CORS grant', async () => {
      const response = await send(stubs.port, '/health', {
        headers: { origin: 'https://conference-site.example' },
      });
      expect(
        Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
      ).toEqual([]);
    });
  });

  describe('where it listens', () => {
    it('is the loopback address only: no other address of this machine accepts a connection', async () => {
      const stubs = await startStubs('test');
      try {
        expect(await accepts('127.0.0.1', stubs.port)).toBe(true);
        const others = Object.values(networkInterfaces())
          .flatMap((addresses) => addresses ?? [])
          .filter((address) => address.family === 'IPv4' && !address.internal)
          .map((address) => address.address);
        for (const address of others) {
          expect({ address, accepted: await accepts(address, stubs.port) }).toEqual({
            address,
            accepted: false,
          });
        }
      } finally {
        await stubs.stop();
      }
    });

    it('says so when its port is taken, and ends', async () => {
      const first = await startStubs('test');
      try {
        const second = await runNode([STUBS], {
          env: { STAGE: 'test', STUBS_PORT: String(first.port) },
          timeoutMs: 20_000,
        });
        expect(second.exitCode).toBe(1);
        expect(second.stderr).toContain('stubs did not run: cannot listen on 127.0.0.1');
      } finally {
        await first.stop();
      }
    });

    it.each(['0', '-1', '65536', '4010x', ' ', '1e3'])('refuses the port "%s"', async (value) => {
      const result = await runNode([STUBS], {
        env: { STAGE: 'test', STUBS_PORT: value },
        timeoutMs: 20_000,
      });
      expect(result.exitCode).toBe(EXIT_CONFIGURATION);
      expect(result.stderr).toContain('  - STUBS_PORT: ');
    });
  });

  describe('refuses to run on a server', () => {
    it.each([
      ['prod', 'prod'],
      ['unset', undefined],
      ['empty', ''],
      ['the long word', 'production'],
      ['upper case', 'LOCAL'],
      ['a trailing space', 'test '],
      ['staging', 'staging'],
    ])('STAGE %s: exit code 78, and nothing listens', async (_name, stage) => {
      const port = await freePort();
      const result = await runNode([STUBS], {
        env: { STAGE: stage, STUBS_PORT: String(port) },
        timeoutMs: 20_000,
      });
      expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({
        exitCode: EXIT_CONFIGURATION,
        stdout: '',
      });
      expect(result.stderr).toContain('stubs did not run');
      expect(result.stderr).toContain('  - STAGE: ');
      expect(await accepts('127.0.0.1', port)).toBe(false);
    });
  });

  describe('how it is started', () => {
    it('is the script stubs of package.json and is documented in the README', () => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(manifest.scripts.stubs).toBe('node --env-file-if-exists=.env scripts/stubs.mjs');
      expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toContain('corepack pnpm stubs');
    });
  });
});
