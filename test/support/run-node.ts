import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const repoRoot = join(__dirname, '..', '..');

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr together, in the order they arrived. */
  readonly output: string;
  /**
   * True when the process was stopped because it ran longer than its time limit. The
   * exit code is then null, and `stderr` and `output` end with a line that says so.
   */
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly input?: string;
  /** The process is stopped after this long. 60 seconds when not given. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

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
    const limit = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, limit);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        // Said in the output itself, so that whatever a test prints of a failed run names
        // the timeout, instead of an empty result that fails further on as something else.
        const note = `\n[timeout] "node ${args.join(' ')}" was stopped after ${String(limit / 1000)} s: it ran into its time limit and did not finish.\n`;
        stderr += note;
        output += note;
      }
      resolve({ exitCode, stdout, stderr, output, timedOut });
    });
    child.stdin.end(options.input ?? '');
  });
}
