import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AppConfig } from '../../src/config/config';
import { ClamdScanner } from '../../src/modules/files/virus-scanner';
import { freePort } from '../support/api-process';
import { EICAR, pdfOf } from '../support/office-files';
import { baseEnvironment, repoRoot, runNode } from '../support/run-node';

/**
 * The fake clamd of the development stack (scripts/fake-clamd.mjs; docker-compose.yml, service
 * fake-clamd): the documented command starts it, the API's real client gets "clean" for a file
 * and "infected" for EICAR from it, it names itself when asked for its version (the topology
 * check of a server refuses that answer), and it refuses to run on a server.
 */

const FAKE = join('scripts', 'fake-clamd.mjs');

interface RunningFake {
  readonly port: number;
  stop(): Promise<number | null>;
}

async function startFake(): Promise<RunningFake> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [FAKE], {
    cwd: repoRoot,
    env: { ...baseEnvironment(), STAGE: 'local', FAKE_CLAMD_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
  const deadline = Date.now() + 20_000;
  while (!output.includes('fake-clamd listens on')) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      await closed;
      throw new Error(`the fake clamd did not start:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    port,
    stop() {
      child.kill();
      return closed;
    },
  };
}

/** One command, one answer, as clamd speaks. */
function ask(port: number, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let answer = '';
    socket.on('connect', () => socket.write(`${command}\0`));
    socket.on('data', (data: Buffer) => (answer += data.toString('latin1')));
    socket.on('end', () => {
      resolve(answer.replace(/\0/g, ''));
    });
    socket.on('error', reject);
  });
}

describe('the fake clamd of the development stack (scripts/fake-clamd.mjs)', () => {
  jest.setTimeout(60_000);
  let fake: RunningFake;

  beforeAll(async () => {
    fake = await startFake();
  });

  afterAll(async () => {
    await fake.stop();
  });

  it('answers the real client of the API: a file is clean, EICAR is found', async () => {
    const scanner = new ClamdScanner({
      files: { storageDirectory: 'tmp', clamav: { host: '127.0.0.1', port: fake.port } },
    } as AppConfig);
    await expect(scanner.scan(Readable.from([pdfOf(200_000)]))).resolves.toEqual({
      verdict: 'clean',
    });
    await expect(scanner.scan(Readable.from([Buffer.from(EICAR)]))).resolves.toEqual({
      verdict: 'infected',
      signature: 'Eicar-Signature',
    });
  });

  it('answers PING, names itself as the fake on VERSION, and knows no other command', async () => {
    expect(await ask(fake.port, 'zPING')).toBe('PONG');
    const version = await ask(fake.port, 'zVERSION');
    expect(version).toMatch(/fake-clamd/);
    // The topology check of a server takes only a real ClamAV's answer (deploy/checks/topology.mjs).
    expect(version).not.toMatch(/^ClamAV \d+\.\d+\.\d+\/\d+\//);
    expect(await ask(fake.port, 'zSCAN /etc/passwd')).toBe('UNKNOWN COMMAND');
  });

  it('the health check of the stack passes against it (no STAGE in the container)', async () => {
    const result = await runNode([FAKE, '--in-development-stack', '--ping'], {
      env: { FAKE_CLAMD_PORT: String(fake.port) },
    });
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['prod', []],
    ['production', []],
    ['', []],
    [undefined, []],
    ['prod', ['--in-development-stack']],
  ])('refuses to run on STAGE=%j %j', async (stage, flags) => {
    const result = await runNode([FAKE, ...flags], {
      env: { STAGE: stage, FAKE_CLAMD_PORT: String(await freePort()) },
    });
    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('fake-clamd did not run');
  });

  it('is a service of the development stack only, started by stack:up, never in an image', () => {
    const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/^ {2}fake-clamd:$/m);
    expect(compose).toContain('./scripts/fake-clamd.mjs:/opt/confera/fake-clamd.mjs:ro');
    expect(readFileSync(join(repoRoot, 'deploy', 'compose.yml'), 'utf8')).not.toMatch(/fake-clamd/);
    expect(readFileSync(join(repoRoot, '.dockerignore'), 'utf8')).not.toMatch(/fake-clamd/);
    const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    expect(example).toMatch(/^CLAMAV_ADDRESS=127\.0\.0\.1:3310$/m);
    expect(example).toMatch(/^CONFERA_CLAMD_PORT=3310$/m);
  });
});
