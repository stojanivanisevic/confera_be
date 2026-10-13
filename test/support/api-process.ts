import { type ChildProcess, spawn } from 'node:child_process';
import { type IncomingHttpHeaders, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { baseEnvironment, repoRoot } from './run-node';

/** Entry file of the production build (`pnpm build`). */
export const PRODUCTION_ENTRY = join('dist', 'main.js');

/** Entry file of the development build (`pnpm build:dev`), which carries the dev-tools module. */
export const DEVELOPMENT_ENTRY = join('dist-dev', 'modules', 'dev-tools', 'main.dev.js');

export interface ApiRequest {
  readonly method?: string;
  /** Sent as they are; `host` overrides the Host header, which is how a test picks a surface. */
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

export interface RunningApi {
  readonly port: number;
  /** Everything the process has printed so far, stdout and stderr together. */
  output(): string;
  request(path: string, init?: ApiRequest): Promise<ApiResponse>;
  /** Stops the process and resolves with everything it printed. */
  stop(): Promise<string>;
}

/** Asks the operating system for a free port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('no port'));
        }
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One HTTP request to 127.0.0.1 with full control over the headers, the Host header included. */
export function send(port: number, path: string, init: ApiRequest = {}): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: init.headers,
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        });
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/**
 * Starts a built entry file as its own process, with exactly the given environment (plus
 * the few variables a process needs to run), and waits until it answers on /health.
 * Rejects when the process ends before that.
 */
export async function startApi(
  entry: string,
  env: Record<string, string | undefined>,
): Promise<RunningApi> {
  const port = await freePort();
  const childEnv: Record<string, string> = { ...baseEnvironment() };
  const requested: Record<string, string | undefined> = {
    ...env,
    PORT: String(port),
    LISTEN_HOST: '127.0.0.1',
  };
  for (const [name, value] of Object.entries(requested)) {
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }

  const child: ChildProcess = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited: number | null | undefined;
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const closed = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      exited = code;
      resolve();
    });
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited !== undefined) {
      throw new Error(
        `the API ended with exit code ${String(exited)} before it answered:\n${output}`,
      );
    }
    try {
      const response = await send(port, '/health');
      if (response.status === 200) {
        break;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      await closed;
      throw new Error(`the API did not answer within 30 s:\n${output}`);
    }
    await delay(100);
  }

  return {
    port,
    output: () => output,
    request: (path, init) => send(port, path, init),
    async stop() {
      child.kill();
      await closed;
      return output;
    },
  };
}
