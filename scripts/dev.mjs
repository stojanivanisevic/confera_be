// `pnpm start:dev`: compiles the development build, keeps compiling on every change and
// restarts the API when the compiled files change.
//
// The development build goes to dist-dev/ and is the only build that contains the
// dev-tools module. The production build (dist/, `pnpm build`) never does (ADR-24).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/process.mjs';

const ENTRY = path.join('dist-dev', 'main.js');

const compiler = spawn(
  process.execPath,
  [path.join('scripts', 'build.mjs'), 'tsconfig.build.dev.json', '--watch'],
  { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] },
);

let api;

function startApi() {
  if (api || !existsSync(path.join(repoRoot, ENTRY))) {
    return;
  }
  api = spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', ENTRY], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  api.on('close', () => {
    api = undefined;
  });
}

compiler.stdout.setEncoding('utf8').on('data', (text) => {
  process.stdout.write(text);
  // The compiler prints this line after every successful or failed pass.
  if (text.includes('Watching for file changes')) {
    startApi();
  }
});

function stop() {
  api?.kill();
  compiler.kill();
}

compiler.on('close', (code) => {
  api?.kill();
  process.exit(code ?? 0);
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
