import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  compoundFileOf,
  adversarialRelationships,
  deflatedZipOf,
  docOf,
  docxOf,
  docxWithRelationships,
  EICAR,
  overlappingZipOf,
  pdfOf,
  zipOf,
} from '../../../test/support/office-files';
import { startFakeClamd } from '../../../test/support/fake-clamd';
import { repoRoot } from '../../../test/support/run-node';
import type { AppConfig } from '../../config/config';
import { attachmentHeader, asciiFileName, safeFileName } from './file-names';
import { detectFileType, MAX_ELEMENT_CHARS, MAX_PARTS_READ } from './file-type';
import type { AppLogger } from '../../common/logging/app-logger';
import type { SystemResolvers } from '../../platform/prisma/system/resolvers';
import type { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { TenantContext } from '../../platform/tenancy/tenant-context';
import type { MailQueue } from '../mail/mail-queue';
import { FilesWorker, retryDelayMs } from './files-worker';
import { mayServe } from './serving';
import { FileStorage, StorageKeyError } from './storage';
import { ClamdScanner, verdictOf, type VirusScanner } from './virus-scanner';

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
    [
      'a PNG',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
      { type: 'png', macros: false },
    ],
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), { type: 'jpeg', macros: false }],
    ['a .docx', docxOf(), { type: 'docx', macros: false }],
    ['a .docx with a VBA project', docxOf({ macros: true }), { type: 'docx', macros: true }],
    ['an old .doc', docOf(), { type: 'doc', macros: false }],
    ['an old .doc with macros', docOf({ macros: true }), { type: 'doc', macros: true }],
    [
      'a renamed executable',
      Buffer.from('MZ\x90\0\x03\0\0\0\x04\0\0\0'),
      { type: null, macros: false },
    ],
    [
      'an HTML page with a script',
      Buffer.from('<html><script>alert(1)</script></html>'),
      { type: null, macros: false },
    ],
    ['a ZIP that is not a document', zipOf({ 'a.txt': 'x' }), { type: null, macros: false }],
    [
      'a compound file that is not a Word document',
      compoundFileOf(['Workbook']),
      { type: null, macros: false },
    ],
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

  describe('the macro check reads parts as Word does (SEC-M3-06)', () => {
    const VBA_TYPE =
      '<Types><Override ContentType="application/vnd.ms-office.vbaProject"/></Types>';
    const withBom = (bom: number[], body: Buffer) => Buffer.concat([Buffer.from(bom), body]);

    it.each([
      [
        'content types in UTF-16 LE with a byte order mark',
        withBom([0xff, 0xfe], Buffer.from(VBA_TYPE, 'utf16le')),
      ],
      [
        'content types in UTF-16 BE with a byte order mark',
        withBom([0xfe, 0xff], Buffer.from(VBA_TYPE, 'utf16le').swap16()),
      ],
      ['content types in UTF-16 LE without one', Buffer.from(VBA_TYPE, 'utf16le')],
      [
        'a character reference in the content type',
        '<Types><Override ContentType="application/vnd.ms-office.vba&#80;roject"/></Types>',
      ],
      [
        'a hexadecimal reference',
        '<Types><Override ContentType="application/vnd.ms-office.vba&#x50;roject"/></Types>',
      ],
    ])('%s, with the VBA part renamed: macros', async (_name, contentTypes) => {
      const zip = zipOf({
        '[Content_Types].xml': contentTypes,
        'word/document.xml': '<w:document/>',
        'word/harmless.bin': Buffer.alloc(64, 1),
      });
      await expect(detectFileType(written(zip))).resolves.toEqual({ type: 'docx', macros: true });
    });

    it('a relationship of a VBA project written with a reference: macros', async () => {
      const zip = zipOf({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<w:document/>',
        'word/_rels/document.xml.rels':
          '<Relationships><Relationship Type="http://schemas.microsoft.com/office/2006/relationships/vba&#x50;roject" Target="x.bin"/></Relationships>',
      });
      await expect(detectFileType(written(zip))).resolves.toEqual({ type: 'docx', macros: true });
    });

    it('a part in UTF-32 cannot be judged: macros (fail closed)', async () => {
      const utf32 = Buffer.alloc(VBA_TYPE.length * 4);
      Array.from(VBA_TYPE).forEach((character, index) => {
        utf32.writeUInt32LE(character.codePointAt(0) ?? 0, index * 4);
      });
      const zip = zipOf({ '[Content_Types].xml': utf32, 'word/document.xml': '<w:document/>' });
      await expect(detectFileType(written(zip))).resolves.toEqual({ type: 'docx', macros: true });
    });

    it.each([
      ['MACROS', true],
      ['_vba_project_cur', true],
      ['Vba', true],
      ['Data', false],
    ])(
      'an old .doc with the storage %j: macros %j (names of a compound file have no case)',
      async (name, macros) => {
        await expect(
          detectFileType(written(compoundFileOf(['WORDDOCUMENT', name]))),
        ).resolves.toEqual({ type: 'doc', macros });
      },
    );

    const relsOf = (relationship: string) =>
      zipOf({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<w:document/>',
        'word/_rels/settings.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship}</Relationships>`,
      });

    it.each([
      [
        'a remote template',
        '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://templates.example.test/t.dotm" TargetMode="External"/>',
        true,
      ],
      [
        'a remote object, attributes in single quotes and another order',
        "<Relationship TargetMode='External' Target='http://x.example.test/o' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject' Id='r2'/>",
        true,
      ],
      [
        'a UNC path, even as a hyperlink',
        '<Relationship Id="r3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="\\\\files.example.test\\share\\a.docx" TargetMode="External"/>',
        true,
      ],
      [
        'a file: target',
        '<Relationship Id="r4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///C:/a.png"/>',
        true,
      ],
      [
        'a plain hyperlink, which the reader must click',
        '<Relationship Id="r5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.example.test/" TargetMode="External"/>',
        false,
      ],
      [
        'a part of the document itself',
        '<Relationship Id="r6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
        false,
      ],
    ])('%s: flagged %j', async (_name, relationship, flagged) => {
      await expect(detectFileType(written(relsOf(relationship)))).resolves.toEqual(
        flagged
          ? { type: 'docx', macros: false, externalLinks: true }
          : { type: 'docx', macros: false },
      );
    });
  });

  describe('the relationship scan is linear (SEC-M3-11)', () => {
    const adversarial = adversarialRelationships();

    // The gate of 100 ms is the timing tier (test/timing/docx-inspection.spec.ts), in plain
    // Node: inside Jest the same scan takes five to twenty times as long. Here a guard that a
    // quadratic scan, hours for 1 MB, could never meet.
    it.each(adversarial)('a 1 MB part of %s is judged in bounded time', async (_name, rels) => {
      const path = written(docxWithRelationships(rels));
      const started = performance.now();
      const detected = await detectFileType(path);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(detected.type).toBe('docx');
    });

    it('every pattern in file-type.ts runs over 1 MB of each shape in under 100 ms', () => {
      const source = readFileSync(
        join(repoRoot, 'src', 'modules', 'files', 'file-type.ts'),
        'utf8',
      );
      const file = ts.createSourceFile('file-type.ts', source, ts.ScriptTarget.Latest, true);
      const patterns: RegExp[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isRegularExpressionLiteral(node)) {
          const text = node.text;
          const slash = text.lastIndexOf('/');
          const flags = text.slice(slash + 1);
          patterns.push(
            new RegExp(text.slice(1, slash), flags.includes('g') ? flags : `${flags}g`),
          );
        }
        // A pattern built at run time could not be judged here: there is none.
        if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
          expect(node.expression.getText(file)).not.toBe('RegExp');
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      for (const pattern of patterns) {
        for (const [name, input] of adversarial) {
          const started = performance.now();
          const matches = input.match(pattern)?.length ?? 0;
          expect({
            pattern: pattern.source,
            name,
            matches,
            fast: performance.now() - started < 100,
          }).toEqual({ pattern: pattern.source, name, matches, fast: true });
        }
      }
    });

    it.each([
      [
        'a decoded &gt; in an earlier value',
        '<Relationship Id="a&gt;" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://x.example.test/t.dotm" TargetMode="External"/>',
      ],
      [
        'a > inside a quoted value',
        '<Relationship Id="a>b" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://x.example.test/t.dotm" TargetMode="External"/>',
      ],
      [
        'a comment with an apostrophe before it',
        '<!-- don\'t --><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://x.example.test/t.dotm" TargetMode="External"/>',
      ],
      [
        'a target written with references',
        '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="&#92;&#92;files.example.test&#92;a.png"/>',
      ],
    ])('an external relationship behind %s is still flagged', async (_name, relationship) => {
      const zip = zipOf({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<w:document/>',
        'word/_rels/settings.xml.rels': `<?xml version="1.0"?><Relationships>${relationship}</Relationships>`,
      });
      await expect(detectFileType(written(zip))).resolves.toEqual({
        type: 'docx',
        macros: false,
        externalLinks: true,
      });
    });

    it(`an element longer than ${MAX_ELEMENT_CHARS} characters is refused as macros`, async () => {
      const zip = zipOf({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<w:document/>',
        'word/_rels/document.xml.rels': `<Relationship Target="${'x'.repeat(MAX_ELEMENT_CHARS)}"/>`,
      });
      await expect(detectFileType(written(zip))).resolves.toEqual({
        type: 'docx',
        macros: true,
        crafted: true,
      });
    });
  });

  describe('the work of the inspection is bounded (SEC-M3-01)', () => {
    it('10 000 records that point at one compressed block are refused in well under a second', async () => {
      const path = written(overlappingZipOf(10_000));
      const started = Date.now();
      await expect(detectFileType(path)).resolves.toEqual({
        type: null,
        macros: false,
        crafted: true,
      });
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('entries that repeat a name (in any casing) are refused', async () => {
      const zip = zipOf({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<w:document/>',
        'WORD/document.xml': '<w:document/>',
      });
      await expect(detectFileType(written(zip))).resolves.toEqual({
        type: null,
        macros: false,
        crafted: true,
      });
    });

    it('parts that inflate to more than the budget in all are refused as macros', async () => {
      const big = ' '.repeat(1024 * 1024 - 1024);
      const zip = deflatedZipOf({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<w:document/>',
        'word/_rels/a.rels': big,
        'word/_rels/b.rels': big,
        'word/_rels/c.rels': big,
      });
      await expect(detectFileType(written(zip))).resolves.toEqual({
        type: 'docx',
        macros: true,
        crafted: true,
      });
    });

    it(`more than ${MAX_PARTS_READ} relationship parts are refused as macros`, async () => {
      const parts: Record<string, string> = {
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<w:document/>',
      };
      for (let index = 0; index < MAX_PARTS_READ + 1; index += 1) {
        parts[`word/_rels/p${index}.rels`] = '<Relationships/>';
      }
      await expect(detectFileType(written(deflatedZipOf(parts)))).resolves.toEqual({
        type: 'docx',
        macros: true,
        crafted: true,
      });
    });

    it('a deflated document with a few relationship parts is a plain .docx', async () => {
      const zip = deflatedZipOf({
        '[Content_Types].xml': '<Types/>',
        '_rels/.rels': '<Relationships/>',
        'word/document.xml': '<w:document/>',
        'word/_rels/document.xml.rels': '<Relationships/>',
      });
      await expect(detectFileType(written(zip))).resolves.toEqual({ type: 'docx', macros: false });
    });
  });
});

/** ST-39: names that cannot break a header or a path, and keep their letters (FR-FILE-03). */
describe('file names (ST-39, FR-FILE-03)', () => {
  it.each([
    ['Serbian letters are kept', 'Biografije š č ć ž đ.docx', 'docx', 'Biografije š č ć ž đ.docx'],
    [
      'a quote and a second parameter',
      'a".pdf"; filename="evil.exe',
      'pdf',
      'a_.pdf__ filename=_evil.exe.pdf',
    ],
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

  it.each([
    'org/../../etc/passwd',
    '../x',
    'org/a/b',
    `org/${randomUUID()}/../${randomUUID()}`,
    '',
  ])('refuses the key %j: the path stays inside its root', (key) => {
    expect(() => storage.pathOf(key)).toThrow(StorageKeyError);
  });
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
          address === null ? null : { host: '127.0.0.1', port: Number(address.split(':')[1]) },
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

  it('a daemon that never answers (a nested archive bomb) ends in bounded time, not clean (ST-38)', async () => {
    const clamd = await startFakeClamd('silent');
    try {
      const scanner = scannerAt(clamd.address);
      scanner.timeoutMs = 300;
      const started = Date.now();
      await expect(scanner.scan(Readable.from([pdfOf()]))).resolves.toEqual({
        verdict: 'unavailable',
        reason: 'timeout',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
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

  it('the purge deletes the row first, and keeps the bytes of a file that a renewal or a submit took meanwhile (SEC-M3-05)', async () => {
    const removed: string[] = [];
    const deletions: unknown[] = [];
    const orphans = [
      { id: 'moved', storageKey: 'org/a/moved' },
      { id: 'orphan', storageKey: 'org/a/orphan' },
    ];
    const database = {
      db: {
        formToken: {
          findMany: () => Promise.resolve([{ id: 'expired-token' }]),
          deleteMany: () => Promise.resolve({ count: 0 }),
        },
        storedFile: {
          findMany: () => Promise.resolve(orphans),
          // Between the look-up and the delete a renewal moved the first file to a new token.
          deleteMany: (query: { where: { id: string } }) => {
            deletions.push(query.where);
            return Promise.resolve({ count: query.where.id === 'moved' ? 0 : 1 });
          },
        },
      },
    };
    const worker = new FilesWorker(
      { jobs: { intervalSeconds: 0 } } as AppConfig,
      {} as VirusScanner,
      { organisationsWithUsers: () => Promise.resolve(['org-a']) } as unknown as SystemResolvers,
      { run: (_id: string, work: () => Promise<void>) => work() } as unknown as TenantContext,
      database as unknown as TenantDatabase,
      {
        removeStaleIncoming: () => Promise.resolve(0),
        remove: (key: string) => {
          removed.push(key);
          return Promise.resolve();
        },
      } as unknown as FileStorage,
      {} as MailQueue,
      { info: () => undefined, warn: () => undefined } as unknown as AppLogger,
    );
    // Only the purge is under test (the fake's look-up of files would answer the scan too).
    jest
      .spyOn(worker as unknown as { scan: () => Promise<void> }, 'scan')
      .mockResolvedValue(undefined);
    const report = await worker.tick(new Date());
    expect(removed).toEqual(['org/a/orphan']);
    expect(report.purged).toBe(1);
    // Each delete names the row and checks again that it is unattached and purgeable.
    expect(deletions[0]).toEqual(
      expect.objectContaining({ id: 'moved', submissionId: null, OR: expect.any(Array) }),
    );
  });

  it('tries a pending scan again after 1, 2, 4 ... minutes, at most an hour apart', () => {
    expect([1, 2, 3, 4, 7, 20].map((attempts) => retryDelayMs(attempts) / 60_000)).toEqual([
      1, 2, 4, 8, 60, 60,
    ]);
  });
});
