import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

export interface PdfContent {
  readonly pages: readonly { readonly lines: readonly string[] }[];
  readonly fonts: readonly { readonly name: string; readonly embedded: boolean }[];
}

const repoRoot = join(__dirname, '..', '..', '..', '..');

/**
 * Reads the text and the fonts of a PDF with pdf.js, an independent reader: what it
 * finds is what a person's PDF viewer shows and copies. Runs test/support/pdf-extract.mjs
 * in its own process.
 */
export function readPdf(pdf: Buffer): Promise<PdfContent> {
  const directory = mkdtempSync(join(tmpdir(), 'confera-pdf-'));
  const file = join(directory, 'document.pdf');
  writeFileSync(file, pdf);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join('test', 'support', 'pdf-extract.mjs'), file], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      rmSync(directory, { recursive: true, force: true });
      if (code === 0) {
        resolve(JSON.parse(stdout) as PdfContent);
      } else {
        reject(new Error(`pdf-extract failed with exit code ${String(code)}:\n${stderr}`));
      }
    });
  });
}

/** The lines of all pages, with runs of white space made one space. */
export function linesOf(content: PdfContent): string[] {
  return content.pages
    .flatMap((page) => page.lines)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
}

/** Names of the fonts in the raw file, for example `ABCDEF+Manrope-Regular`. */
export function rawFontNames(pdf: Buffer): string[] {
  const text = pdf.toString('latin1');
  return [
    ...new Set([...text.matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)].map((m) => m[1] ?? '')),
  ].sort();
}

/** How many font programs (TrueType or OpenType data) the raw file holds. */
export function embeddedFontPrograms(pdf: Buffer): number {
  return [...pdf.toString('latin1').matchAll(/\/FontFile[23]?\s/g)].length;
}

const STREAM_START = /stream\r?\n/g;
const RANGE_BLOCK = /beginbfrange([^]*?)endbfrange/g;
const TARGET_LIST = /\[([^\]]*)\]/g;
const HEX_ENTRY = /<([0-9a-fA-F\s]+)>/g;

/**
 * What each glyph of the file stands for, read from the ToUnicode maps of its fonts:
 * one text per glyph. A glyph that stands for more than one character is a ligature,
 * and some readers copy only the first letter of it.
 */
export function glyphTexts(pdf: Buffer): string[] {
  const texts: string[] = [];
  const raw = pdf.toString('latin1');
  for (const match of raw.matchAll(STREAM_START)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    let content: string;
    try {
      content = inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    if (!content.includes('begincmap')) {
      continue;
    }
    for (const range of content.matchAll(RANGE_BLOCK)) {
      for (const list of (range[1] ?? '').matchAll(TARGET_LIST)) {
        for (const entry of (list[1] ?? '').matchAll(HEX_ENTRY)) {
          // UTF-16, big endian, as hexadecimal digits; a ligature has its units apart.
          const units = (entry[1] ?? '').replaceAll(/[^0-9a-fA-F]/g, '').match(/.{4}/g) ?? [];
          texts.push(String.fromCharCode(...units.map((unit) => parseInt(unit, 16))));
        }
      }
    }
  }
  return texts;
}
