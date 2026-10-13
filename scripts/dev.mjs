// `pnpm start:dev`: compiles the development build, keeps compiling on every change and
// restarts the API after each compilation without errors. Stop it with Ctrl+C.
//
// The development build goes to dist-dev/ and is the only build that contains the
// dev-tools module. The production build (dist/, `pnpm build`) never does (ADR-24).
//
// Two child processes, both ended when this script ends: the compiler in watch mode and
// the API. The API is started directly, not through `node --watch`, because on Windows
// that would leave a grandchild behind that keeps the port.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/process.mjs';

const ENTRY = path.join('dist-dev', 'modules', 'dev-tools', 'main.dev.js');

/** What the TypeScript compiler prints after a pass without errors. */
const COMPILED = /Found 0 errors\. Watching for file changes/;

const compiler = spawn(
  process.execPath,
  [path.join('scripts', 'build.mjs'), 'tsconfig.build.dev.json', '--watch'],
  { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] },
);

let api;
let stopping = false;

function startApi() {
  if (stopping || !existsSync(path.join(repoRoot, ENTRY))) {
    return;
  }
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', ENTRY], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  api = child;
  child.on('close', () => {
    if (api === child) {
      api = undefined;
    }
  });
}

function restartApi() {
  if (api === undefined) {
    startApi();
    return;
  }
  const running = api;
  running.once('close', startApi);
  running.kill();
}

compiler.stdout.setEncoding('utf8').on('data', (text) => {
  process.stdout.write(text);
  if (COMPILED.test(text)) {
    restartApi();
  }
});

function stop() {
  stopping = true;
  api?.kill();
  compiler.kill();
}

compiler.on('close', (code) => {
  stop();
  process.exitCode = code ?? 0;
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGBREAK', stop);
process.on('exit', stop);
