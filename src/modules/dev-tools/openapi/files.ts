import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConferaDocuments } from './document';

/** The committed OpenAPI files (ADR-19). The frontend vendors `openapi.json` with a lock. */
export const OPENAPI_FILES = {
  admin: 'openapi.json',
  public: 'openapi.public.json',
} as const;

export type DocumentName = keyof typeof OPENAPI_FILES;

/** The exact text of a committed file: two-space JSON, LF line ends, one final line break. */
export function serialise(document: unknown): string {
  // Invisible and format characters (a no-break space, a direction override) are written as
  // their escape, so that a reviewer of a committed file sees them; the JSON is the same.
  return `${JSON.stringify(document, null, 2).replace(INVISIBLE, escapeUnits)}\n`;
}

/** A character as the \\u escapes of its UTF-16 code units. */
function escapeUnits(character: string): string {
  let escaped = '';
  for (let index = 0; index < character.length; index += 1) {
    escaped += `\\u${character.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return escaped;
}

/** White space other than the plain space, and the format characters of Unicode. */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu;

export interface Drift {
  readonly file: string;
  readonly reason: 'missing' | 'different';
  /** First line that differs (1-based), for a `different` file. */
  readonly line?: number;
  readonly committed?: string;
  readonly generated?: string;
}

/** Compares the text generated from the code with the text of a committed file. */
export function compare(
  file: string,
  generated: string,
  committed: string | undefined,
): Drift | undefined {
  if (committed === undefined) {
    return { file, reason: 'missing' };
  }
  // A checkout with CRLF line ends is the same document.
  const committedLines = committed.replace(/\r\n/g, '\n').split('\n');
  const generatedLines = generated.split('\n');
  const length = Math.max(committedLines.length, generatedLines.length);
  for (let index = 0; index < length; index += 1) {
    if (committedLines[index] !== generatedLines[index]) {
      return {
        file,
        reason: 'different',
        line: index + 1,
        committed: committedLines[index],
        generated: generatedLines[index],
      };
    }
  }
  return undefined;
}

export function findDrift(directory: string, documents: ConferaDocuments): Drift[] {
  const drift: Drift[] = [];
  for (const name of Object.keys(OPENAPI_FILES) as DocumentName[]) {
    const path = join(directory, OPENAPI_FILES[name]);
    const committed = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    const difference = compare(OPENAPI_FILES[name], serialise(documents[name]), committed);
    if (difference !== undefined) {
      drift.push(difference);
    }
  }
  return drift;
}

export function writeDocuments(directory: string, documents: ConferaDocuments): string[] {
  mkdirSync(directory, { recursive: true });
  return (Object.keys(OPENAPI_FILES) as DocumentName[]).map((name) => {
    const path = join(directory, OPENAPI_FILES[name]);
    writeFileSync(path, serialise(documents[name]), 'utf8');
    return path;
  });
}

export function formatDrift(drift: readonly Drift[]): string {
  return drift
    .map((item) =>
      item.reason === 'missing'
        ? `  ${item.file}: the file does not exist`
        : [
            `  ${item.file}: differs from the code at line ${String(item.line)}`,
            `      committed: ${item.committed ?? '(end of file)'}`,
            `      generated: ${item.generated ?? '(end of file)'}`,
          ].join('\n'),
    )
    .join('\n');
}
