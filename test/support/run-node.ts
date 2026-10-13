import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const repoRoot = join(__dirname, '..', '..');

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr together, in the order they arrived. */
  readonly output: string;
}

export interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly input?: string;
  readonly timeoutMs?: number;
}

/**
 * The few variables of the parent process that a child needs in order to run at all.
 * Nothing else is inherited, so a test decides every variable the application sees.
 */
export function baseEnvironment(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME']) {
    const value = process.env[name];
    if (value !== undefined) {
      base[name] = value;
    }
  }
  return base;
}

/** Runs `node <args>` in the repository root and collects what it prints. */
export function runNode(args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = baseEnvironment();
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value !== undefined) {
        env[name] = value;
      }
    }
    const child = spawn(process.execPath, [...args], { cwd: repoRoot, env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
    }, options.timeoutMs ?? 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, output });
    });
    child.stdin.end(options.input ?? '');
  });
}
