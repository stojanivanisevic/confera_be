import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectFileType } from '../../src/modules/files/file-type';
import { safeFileName } from '../../src/modules/files/file-names';
import { zipOf } from '../support/office-files';
import { repoRoot } from '../support/run-node';

/**
 * Probes of the file checks of 0.3.0 (M3-QA-03, ST-38, ST-39, G2-22) with files that lie.
 */
const folder = mkdtempSync(join(repoRoot, 'tmp', 'qa-m3-files-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

let counter = 0;
async function detect(content: Buffer) {
  counter += 1;
  const path = join(folder, `f${String(counter)}`);
  writeFileSync(path, content);
  return detectFileType(path);
}

describe('files that lie (M3-QA-03)', () => {
  it('Q3-10: a .docx whose VBA project has another part name is still a .docx with macros (G2-22)', async () => {
    // Word finds the VBA project by its content type and relationship, not by the part's name.
    const renamed = zipOf({
      '[Content_Types].xml':
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>' +
        '<Override PartName="/word/slike.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
      'word/document.xml': '<?xml version="1.0"?><w:document/>',
      'word/_rels/document.xml.rels':
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="slike.bin"/></Relationships>',
      'word/slike.bin': Buffer.alloc(64, 1),
    });
    expect(await detect(renamed)).toEqual({ type: 'docx', macros: true });
  });

  it('holds: a picture, a web page or a program named .pdf is not a PDF', async () => {
    expect(
      (await detect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).type,
    ).toBe('png');
    expect((await detect(Buffer.from('<html><script>alert(1)</script></html>'))).type).toBeNull();
    expect((await detect(Buffer.from('MZ\x90\x00\x03\x00\x00\x00'))).type).toBeNull();
  });

  it('holds: a docx with a deeply nested archive inside is read from its directory only, at once', async () => {
    let inner = zipOf({ 'a.txt': Buffer.alloc(1024, 0x41) });
    for (let depth = 0; depth < 8; depth += 1) {
      inner = zipOf({ [`l${String(depth)}.zip`]: inner, [`m${String(depth)}.zip`]: inner });
    }
    const docx = zipOf({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document/>',
      'word/embeddings/oleObject1.bin': inner,
    });
    const started = Date.now();
    expect(await detect(docx)).toEqual({ type: 'docx', macros: false });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('holds: Serbian letters stay, in composed form, whatever the computer wrote (FR-FILE-03)', () => {
    // macOS writes names decomposed: "c" + U+0301 for ć.
    const decomposed = 'Šćepanović – Đorđe Ž.docx'.normalize('NFD');
    expect(safeFileName(decomposed, 'docx')).toBe('Šćepanović – Đorđe Ž.docx');
    expect(safeFileName('Биографије аутора.pdf', 'pdf')).toBe('Биографије аутора.pdf');
  });

  it('holds: a name that claims another type gets the extension of its content', () => {
    expect(safeFileName('rad.pdf.exe', 'pdf')).toBe('rad.pdf.exe.pdf');
    expect(safeFileName('CON.docx', 'docx')).toBe('_CON.docx');
    expect(safeFileName('..\\..\\windows\\win.ini', 'pdf')).toBe('win.ini.pdf');
  });
});
