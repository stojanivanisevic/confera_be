import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  compoundFileOf,
  docOf,
  docxOf,
  EICAR,
  pdfOf,
  zipOf,
} from '../../../test/support/office-files';
import { startFakeClamd } from '../../../test/support/fake-clamd';
import { repoRoot } from '../../../test/support/run-node';
import type { AppConfig } from '../../config/config';
import { attachmentHeader, asciiFileName, safeFileName } from './file-names';
import { detectFileType } from './file-type';
import { retryDelayMs } from './files-worker';
import { mayServe } from './serving';
import { FileStorage, StorageKeyError } from './storage';
import { ClamdScanner, verdictOf } from './virus-scanner';

const folder = join(repoRoot, 'tmp', `files-unit-${randomUUID()}`);

beforeAll(() => {
  mkdirSync(folder, { recursive: true });
});
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

function written(content: Buffer): string {
  const path = join(folder, randomUUID());
  writeFileSync(path, content);
  return path;
}

/** The type of a file by its content, and the macro policy of G2-22 (ADR-10, NFR-SEC-06). */
describe('the type of a file, from its content', () => {
  it.each([
    ['a PDF', pdfOf(), { type: 'pdf', macros: false }],
    ['a PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), { type: 'png', macros: false }],
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), { type: 'jpeg', macros: false }],
    ['a .docx', docxOf(), { type: 'docx', macros: false }],
    ['a .docx with a VBA project', docxOf({ macros: true }), { type: 'docx', macros: true }],
    ['an old .doc', docOf(), { type: 'doc', macros: false }],
    ['an old .doc with macros', docOf({ macros: true }), { type: 'doc', macros: true }],
    ['a renamed executable', Buffer.from('MZ\x90\0\x03\0\0\0\x04\0\0\0'), { type: null, macros: false }],
    ['an HTML page with a script', Buffer.from('<html><script>alert(1)</script></html>'), { type: null, macros: false }],
    ['a ZIP that is not a document', zipOf({ 'a.txt': 'x' }), { type: null, macros: false }],
    ['a compound file that is not a Word document', compoundFileOf(['Workbook']), { type: null, macros: false }],
    ['an empty file', Buffer.alloc(0), { type: null, macros: false }],
    ['a broken ZIP', Buffer.from('PK\x03\x04 broken'), { type: null, macros: false }],
  ])('%s', async (_name, content, expected) => {
    await expect(detectFileType(written(content))).resolves.toEqual(expected);
  });

  it('a ZIP that claims more entries than any document has is refused in bounded time', async () => {
    const zip = docxOf();
    // The end record names 65 000 entries and a directory of 4 GB.
    const forged = Buffer.from(zip);
    forged.writeUInt16LE(65_000, forged.length - 12);
    forged.writeUInt32LE(0xfffffff0, forged.length - 10);
    const started = Date.now();
    await expect(detectFileType(written(forged))).resolves.toEqual({ type: null, macros: false });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/** ST-39: names that cannot break a header or a path, and keep their letters (FR-FILE-03). */
describe('file names (ST-39, FR-FILE-03)', () => {
  it.each([
    ['Serbian letters are kept', 'Biografije š č ć ž đ.docx', 'docx', 'Biografije š č ć ž đ.docx'],
    ['a quote and a second parameter', 'a".pdf"; filename="evil.exe', 'pdf', 'a_.pdf__ filename=_evil.exe.pdf'],
    ['line breaks', 'red1\r\nContent-Type: text.pdf', 'pdf', 'red1Content-Type_ text.pdf'],
    ['a slash is a path: its last part is the name', 'text/html.pdf', 'pdf', 'html.pdf'],
    ['a right-to-left override', 'invoice\u202Efdp.exe', 'pdf', 'invoicefdp.exe.pdf'],
    ['parent-directory parts', '..\\..\\windows\\system32\\a.pdf', 'pdf', 'a.pdf'],
    ['a reserved device name', 'CON.pdf', 'pdf', '_CON.pdf'],
    ['another reserved name', 'lpt1', 'docx', '_lpt1.docx'],
    ['the extension of the content', 'photo.pdf', 'docx', 'photo.pdf.docx'],
    ['a jpeg named .jpeg', 'slika.JPEG', 'jpeg', 'slika.jpg'],
    ['nothing but dots', '...', 'pdf', 'file.pdf'],
  ] as const)('%s', (_name, original, type, expected) => {
    expect(safeFileName(original, type)).toBe(expected);
  });

  it('300 characters are cut to 150 before the extension', () => {
    const name = safeFileName(`${'ž'.repeat(300)}.pdf`, 'pdf');
    expect(name).toBe(`${'ž'.repeat(150)}.pdf`);
  });

  it('the header is an attachment with an ASCII name and the exact name in filename*', () => {
    expect(attachmentHeader('Biografije šđ (1).pdf')).toBe(
      `attachment; filename="Biografije sd _1_.pdf"; filename*=UTF-8''Biografije%20%C5%A1%C4%91%20%281%29.pdf`,
    );
    expect(asciiFileName('Đorđe Šćepanović.docx')).toBe('Dorde Scepanovic.docx');
    const header = attachmentHeader(safeFileName('a"\r\n; filename=x.pdf', 'pdf'));
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/filename=/g)).toHaveLength(1);
  });
});

describe('the storage (ADR-10)', () => {
  const storage = new FileStorage({ files: { storageDirectory: folder } } as AppConfig);

  it('a key is the organisation and a UUID, never a client name', () => {
    expect(storage.newKey('0e2e0000-0000-4000-8000-00000000000A')).toMatch(
      /^org\/0e2e0000-0000-4000-8000-00000000000a\/[0-9a-f-]{36}$/,
    );
  });

  it.each(['org/../../etc/passwd', '../x', 'org/a/b', `org/${randomUUID()}/../${randomUUID()}`, ''])(
    'refuses the key %j: the path stays inside its root',
    (key) => {
      expect(() => storage.pathOf(key)).toThrow(StorageKeyError);
    },
  );
});

describe('the antivirus (M3-BE-08, ST-38)', () => {
  it.each([
    ['stream: OK\0', { verdict: 'clean' }],
    ['stream: Eicar-Signature FOUND\0', { verdict: 'infected', signature: 'Eicar-Signature' }],
    ['stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0', { verdict: 'limits_exceeded' }],
    ['INSTREAM size limit exceeded. ERROR\0', { verdict: 'limits_exceeded' }],
    ["stream: Can't allocate memory ERROR\0", { verdict: 'unavailable', reason: 'scanner_error' }],
    ['', { verdict: 'unavailable', reason: 'scanner_error' }],
  ])('reads %j', (answer, verdict) => {
    expect(verdictOf(answer)).toEqual(verdict);
  });

  const scannerAt = (address: string | null) =>
    new ClamdScanner({
      files: {
        storageDirectory: folder,
        clamav:
          address === null
            ? null
            : { host: '127.0.0.1', port: Number(address.split(':')[1]) },
      },
    } as AppConfig);

  it('asks clamd over INSTREAM: clean, infected, limits exceeded', async () => {
    const clamd = await startFakeClamd('clean');
    try {
      const scanner = scannerAt(clamd.address);
      await expect(scanner.scan(Readable.from([pdfOf(200_000)]))).resolves.toEqual({
        verdict: 'clean',
      });
      await expect(scanner.scan(Readable.from([Buffer.from(EICAR)]))).resolves.toEqual({
        verdict: 'infected',
        signature: 'Eicar-Signature',
      });
      clamd.mode = 'limits';
      await expect(scanner.scan(Readable.from([pdfOf()]))).resolves.toEqual({
        verdict: 'limits_exceeded',
      });
      expect(clamd.scans).toBe(3);
    } finally {
      await clamd.close();
    }
  });

  it('fails closed: no daemon, no configuration, a daemon that errs', async () => {
    await expect(scannerAt('127.0.0.1:9').scan(Readable.from([pdfOf()]))).resolves.toEqual({
      verdict: 'unavailable',
      reason: 'unreachable',
    });
    await expect(scannerAt(null).scan(Readable.from([pdfOf()]))).resolves.toEqual({
      verdict: 'unavailable',
      reason: 'not_configured',
    });
    const clamd = await startFakeClamd('error');
    try {
      await expect(scannerAt(clamd.address).scan(Readable.from([pdfOf()]))).resolves.toEqual({
        verdict: 'unavailable',
        reason: 'scanner_error',
      });
    } finally {
      await clamd.close();
    }
  });

  it('serves an uploaded file only when clean; a generated PDF always (ST-38)', () => {
    expect(mayServe({ kind: 'submission_file', scanState: 'clean' })).toBe('serve');
    expect(mayServe({ kind: 'submission_file', scanState: 'pending' })).toBe('scan_pending');
    expect(mayServe({ kind: 'submission_file', scanState: 'infected' })).toBe('file_not_clean');
    expect(mayServe({ kind: 'submission_file', scanState: 'not_clean' })).toBe('file_not_clean');
    expect(mayServe({ kind: 'generated_document', scanState: 'pending' })).toBe('serve');
  });

  it('tries a pending scan again after 1, 2, 4 ... minutes, at most an hour apart', () => {
    expect([1, 2, 3, 4, 7, 20].map((attempts) => retryDelayMs(attempts) / 60_000)).toEqual([
      1, 2, 4, 8, 60, 60,
    ]);
  });
});
