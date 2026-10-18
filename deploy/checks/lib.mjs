// Helpers of the Docker checks in deploy/checks (M4-BE-07, M4-BE-08). Plain Node, no dependency.
//
// Every image and container a check makes is named with the prefix of CHECK_PREFIX, so that a
// check never touches another stack on the same machine, and is removed when the check ends.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const artifactsDir = path.join(repoRoot, '.artifacts', 'deploy-checks');

/** Names of everything a check creates start with this. */
export const CHECK_PREFIX = 'confera-m4-infra';

/** Runs a command; returns { code, stdout, stderr }. Never throws on a non-zero exit. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    input: options.input,
    ...(options.env ? { env: options.env } : {}),
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 20 * 60 * 1000,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '') + (result.error ? String(result.error) : ''),
  };
}

export function docker(args, options = {}) {
  return run('docker', args, options);
}

/** Runs docker and fails the check with its output when it does not succeed. */
export function dockerOk(args, options = {}) {
  const result = docker(args, options);
  if (result.code !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed (${String(result.code)}):\n${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

/** A log of one check run, under .artifacts/deploy-checks/<name>.log (git ignores .artifacts/). */
export function createLog(name) {
  mkdirSync(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, `${name}.log`);
  writeFileSync(file, `${name} ${new Date().toISOString()}\n`);
  return {
    file,
    write(text) {
      appendFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
    },
  };
}

/** Collects named results and prints them as the check goes. */
export function createResults(log) {
  const results = [];
  return {
    check(name, passed, detail = '') {
      results.push({ name, passed });
      const line = `${passed ? 'ok  ' : 'FAIL'}  ${name}${!passed && detail ? `\n      ${detail}` : ''}`;
      process.stdout.write(`${line}\n`);
      log.write(line);
    },
    get failed() {
      return results.filter((result) => !result.passed).length;
    },
    get count() {
      return results.length;
    },
  };
}
