// Small helpers shared by the scripts in this folder. Plain Node, no dependencies,
// so they run on Windows, macOS and Linux and before anything is built.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Loads `.env` from the repository root when it exists. Scripts only; the application never reads files. */
export function loadDotEnv() {
  const file = path.join(repoRoot, '.env');
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

/** Runs a program and resolves with its exit code. Output goes straight to the terminal. */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/** Runs a Node script of this repository or of a dependency. */
export function runNode(args, options = {}) {
  return run(process.execPath, args, options);
}

/**
 * Runs a pnpm command through the same pnpm that started the current script.
 * `pnpm` is often not on PATH (it is started as `corepack pnpm`), so the name cannot be used.
 */
export function runPnpm(args, options = {}) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) {
    throw new Error('Start this script through pnpm, for example: corepack pnpm check');
  }
  return runNode([pnpm, ...args], options);
}

/** Path of a file inside node_modules, for running a tool's own entry file with Node. */
export function tool(...segments) {
  return path.join(repoRoot, 'node_modules', ...segments);
}
