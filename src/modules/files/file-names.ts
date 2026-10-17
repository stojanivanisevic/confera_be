import type { FileType } from '../forms/catalogue';
import { EXTENSIONS } from './file-type';

/**
 * File names (ADR-10, FR-FILE-03, ST-39). The name a person's computer gave a file is kept
 * for display and download, with Serbian letters, but cleaned once, when it is stored:
 *
 * - composed (NFC); only the last part of a path (`..\..\x.pdf` is `x.pdf`);
 * - no control or invisible character (a right-to-left override cannot turn `fdp.exe` into
 *   what looks like `exe.pdf`), no quote, and none of `< > : " / \ | ? *`;
 * - not a reserved device name of Windows (`CON`, `NUL`, `COM1` ... get a `_` in front);
 * - at most 150 characters before the extension;
 * - the extension of the type the content has, whatever the name said.
 *
 * The download header names the file twice (RFC 6266): a plain ASCII `filename` for old
 * programs and the exact name in `filename*` (RFC 5987), so neither a quote nor a second
 * parameter nor a line break can reach the header.
 */
const MAX_BASE = 150;

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function cutToCodePoints(text: string, max: number): string {
  let result = '';
  let count = 0;
  for (const character of text) {
    if (count === max) {
      break;
    }
    result += character;
    count += 1;
  }
  return result;
}

export function safeFileName(original: string, type: FileType): string {
  const lastPart = original.normalize('NFC').split(/[/\\]/).pop() ?? '';
  const cleaned = lastPart
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[<>:"/\\|?*';`]/g, '_')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s.]+|[\s.]+$/gu, '');
  const extension = EXTENSIONS[type];
  const known = type === 'jpeg' ? ['jpg', 'jpeg'] : [extension];
  const dot = cleaned.lastIndexOf('.');
  let base =
    dot > 0 && known.includes(cleaned.slice(dot + 1).toLowerCase())
      ? cleaned.slice(0, dot)
      : cleaned;
  base = cutToCodePoints(base.replace(/[\s.]+$/u, ''), MAX_BASE);
  if (base === '') {
    base = 'file';
  }
  if (RESERVED.test(base.split('.')[0] ?? '')) {
    base = `_${base}`;
  }
  return `${base}.${extension}`;
}

/** The name in plain ASCII: letters without their marks (š to s, đ to d), anything else `_`. */
export function asciiFileName(name: string): string {
  return name
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_');
}

/** RFC 5987: every byte that is not plain is %-escaped, the quote and brackets too. */
function encodeExtended(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The Content-Disposition of a download: always an attachment, never shown in the browser. */
export function attachmentHeader(name: string): string {
  return `attachment; filename="${asciiFileName(name)}"; filename*=UTF-8''${encodeExtended(name)}`;
}
