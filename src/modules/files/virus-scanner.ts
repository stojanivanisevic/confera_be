import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';

/**
 * The antivirus (ADR-10, B1, M3-BE-08) behind an interface: ClamAV's daemon, asked over its
 * INSTREAM command. Fail closed: whatever is not a clear "OK" is not clean.
 *
 * - `clean`: clamd answered `stream: OK`;
 * - `infected`: it found a signature (the name stays in the log of the scan, as a code);
 * - `limits_exceeded`: a size, depth or count limit of the scanner was exceeded, or clamd
 *   reported a heuristic limit: counts as not clean (ADR-10);
 * - `unavailable`: no answer, a refused connection, a timeout or an error: the file stays
 *   pending and is tried again.
 */
export type ScanVerdict =
  | { readonly verdict: 'clean' }
  | { readonly verdict: 'infected'; readonly signature: string }
  | { readonly verdict: 'limits_exceeded' }
  | { readonly verdict: 'unavailable'; readonly reason: string };

export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

export interface VirusScanner {
  scan(content: Readable): Promise<ScanVerdict>;
}

/** The longest a scan may take before it counts as unavailable (a nested archive ends here at the latest). */
export const SCAN_TIMEOUT_MS = 120_000;
const CHUNK = 64 * 1024;

/** Reads clamd's one-line answer: `stream: OK`, `stream: Name FOUND`, `... ERROR`. */
export function verdictOf(answer: string): ScanVerdict {
  const text = answer.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(text)) {
    return { verdict: 'clean' };
  }
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found?.[1] !== undefined) {
    return found[1].startsWith("Heuristics.Limits.Exceeded")
      ? { verdict: 'limits_exceeded' }
      : { verdict: 'infected', signature: found[1].slice(0, 200) };
  }
  if (/limit exceeded/i.test(text)) {
    return { verdict: 'limits_exceeded' };
  }
  return { verdict: 'unavailable', reason: 'scanner_error' };
}

@Injectable()
export class ClamdScanner implements VirusScanner {
  /** The longest one scan may take; a test shortens it. */
  timeoutMs = SCAN_TIMEOUT_MS;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  scan(content: Readable): Promise<ScanVerdict> {
    const target = this.config.files.clamav;
    if (target === null) {
      content.destroy();
      return Promise.resolve({ verdict: 'unavailable', reason: 'not_configured' });
    }
    return new Promise<ScanVerdict>((resolvePromise) => {
      let settled = false;
      let answer = '';
      const socket = createConnection({ host: target.host, port: target.port });
      const finish = (verdict: ScanVerdict): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        content.destroy();
        socket.destroy();
        resolvePromise(verdict);
      };
      const timer = setTimeout(() => {
        finish({ verdict: 'unavailable', reason: 'timeout' });
      }, this.timeoutMs);
      timer.unref();
      socket.on('error', () => {
        finish({ verdict: 'unavailable', reason: 'unreachable' });
      });
      socket.on('data', (chunk: Buffer) => {
        answer += chunk.toString('utf8');
        if (answer.includes('\0') || answer.length > 1000) {
          finish(verdictOf(answer));
        }
      });
      socket.on('end', () => {
        finish(answer === '' ? { verdict: 'unavailable', reason: 'no_answer' } : verdictOf(answer));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        content.on('data', (data: Buffer | string) => {
          const bytes = typeof data === 'string' ? Buffer.from(data) : data;
          for (let offset = 0; offset < bytes.length; offset += CHUNK) {
            const piece = bytes.subarray(offset, offset + CHUNK);
            const length = Buffer.alloc(4);
            length.writeUInt32BE(piece.length);
            socket.write(length);
            socket.write(piece);
          }
        });
        content.on('end', () => {
          socket.write(Buffer.alloc(4));
        });
        content.on('error', () => {
          finish({ verdict: 'unavailable', reason: 'read_failed' });
        });
      });
    });
  }
}
