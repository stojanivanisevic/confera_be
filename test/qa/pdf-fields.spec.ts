import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissingGlyphError } from '../../src/platform/pdf/glyph-coverage';
import { type PdfDocument, PdfRenderer } from '../../src/platform/pdf/pdf-renderer';
import { linesOf, rawFontNames, readPdf } from '../../src/platform/pdf/testing/read-pdf';
import { runNode } from '../support/run-node';

/**
 * Serbian text in every field of a PDF, and the glyph check in every field (ADR-16,
 * edge case of M1: "Serbian characters in a PDF").
 *
 * The golden test of the spike puts its text into the body of the document. A proforma
 * also has a header, a footer, a watermark on staging, lists, columns and nested tables,
 * and pdfmake has more places still where a layout can put text. Two things must hold in
 * EVERY one of them:
 *
 * 1. š č ć ž đ and Cyrillic come back from the PDF exactly as they went in;
 * 2. a character that no embedded font has stops the render (ADR-16: "every character
 *    of the snapshot is checked against the embedded fonts"), because the PDF library
 *    itself prints an empty box and says nothing.
 */

const UNKNOWN = '中';

interface PdfInformation {
  readonly title: string | null;
  readonly author: string | null;
  readonly subject: string | null;
  readonly keywords: string | null;
}

/** The document information as a PDF reader shows it, read with pdf.js in its own process. */
async function readInformation(pdf: Buffer): Promise<PdfInformation> {
  const directory = mkdtempSync(join(tmpdir(), 'confera-pdf-info-'));
  try {
    const file = join(directory, 'document.pdf');
    writeFileSync(file, pdf);
    const result = await runNode([join('test', 'support', 'pdf-info.mjs'), file]);
    if (result.exitCode !== 0) {
      throw new Error(`pdf-info failed:
${result.output}`);
    }
    return JSON.parse(result.stdout) as PdfInformation;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** One text per field, each with all ten letters and its own first word. */
const FIELD = {
  header: 'Zaglavlje šđčćž ŠĐČĆŽ',
  footer: 'Podnožje šđčćž ŠĐČĆŽ strana',
  string: 'Tekst šđčćž ŠĐČĆŽ',
  text: 'Pasus šđčćž ŠĐČĆŽ',
  nested: 'Ugnežđeno šđčćž ŠĐČĆŽ',
  tableHead: 'Ćelija šđčćž ŠĐČĆŽ',
  tableCell: 'Đak šđčćž ŠĐČĆŽ',
  innerTable: 'Unutrašnja šđčćž ŠĐČĆŽ',
  bullet: 'Stavka šđčćž ŠĐČĆŽ',
  numbered: 'Broj šđčćž ŠĐČĆŽ',
  column: 'Kolona šđčćž ŠĐČĆŽ',
  stack: 'Slog šđčćž ŠĐČĆŽ',
  cyrillic: 'Ћирилица Ђорђе Жикић Љубичица Њежић Џемал',
  fallback: 'Digrafi ǅemal ǈubica ǌegoš',
} as const;

function everyField(): PdfDocument {
  return {
    pageSize: 'A4',
    pageMargins: [48, 72, 48, 72],
    header: { text: FIELD.header, margin: [48, 24, 48, 0] },
    footer: (page: number) => ({
      text: `${FIELD.footer} ${String(page)}`,
      margin: [48, 24, 48, 0],
    }),
    content: [
      FIELD.string,
      { text: FIELD.text, bold: true },
      { text: ['Niz: ', { text: FIELD.nested, bold: true }] },
      {
        table: {
          headerRows: 1,
          body: [
            [{ text: FIELD.tableHead, bold: true }, 'Iznos'],
            [FIELD.tableCell, { table: { body: [[FIELD.innerTable]] } }],
          ],
        },
      },
      { ul: [FIELD.bullet] },
      { ol: [FIELD.numbered] },
      { columns: [FIELD.column, { stack: [FIELD.stack] }] },
      FIELD.cyrillic,
      FIELD.fallback,
    ],
  };
}

describe('Serbian text in every field of a PDF', () => {
  jest.setTimeout(120_000);

  const renderer = new PdfRenderer();

  describe('comes back exactly as it went in', () => {
    let lines: string[];
    let pdf: Buffer;

    beforeAll(async () => {
      pdf = await renderer.render(everyField());
      lines = linesOf(await readPdf(pdf));
    });

    it.each(Object.entries(FIELD))('%s', (name, text) => {
      const expected = name === 'footer' ? `${text} 1` : text;
      expect(lines.some((line) => line.includes(expected))).toBe(true);
    });

    it('with no letter turned into another one or dropped anywhere', () => {
      const extracted = lines.join('\n');
      const count = (text: string, letter: string): number => text.split(letter).length - 1;
      const input = [...Object.values(FIELD), '1'].join('\n');
      for (const letter of 'šđčćžŠĐČĆŽЋЂЖЉЊЏǅǈǌ') {
        expect({ letter, n: count(extracted, letter) }).toEqual({
          letter,
          n: count(input, letter),
        });
      }
      // The replacement character and the empty box never appear.
      expect(extracted).not.toMatch(/[�□]/);
    });

    it('with embedded fonts only', () => {
      for (const name of rawFontNames(pdf)) {
        expect(name).toMatch(/^[A-Z]{6}\+(Manrope|NotoSans)-(Regular|Bold)$/);
      }
    });
  });

  describe('in the document information', () => {
    it('a title, an author and a subject with š č ć ž đ are stored as they are', async () => {
      const information = {
        title: 'Predračun šđčćž ŠĐČĆŽ',
        author: 'Živana Đorđević',
        subject: 'Članarina za 2026. (đački popust)',
        keywords: 'predračun, članarina, Ђорђе',
      };
      const pdf = await renderer.render({ info: information, content: ['a'] });
      expect(await readInformation(pdf)).toEqual(information);
    });
  });

  describe('a character that no font has stops the render, wherever a layout puts it', () => {
    const cases: [string, PdfDocument][] = [
      ['the header, as a function', { header: () => ({ text: UNKNOWN }), content: ['a'] }],
      ['the footer, static', { footer: { text: UNKNOWN }, content: ['a'] }],
      [
        'a footer function that returns columns',
        { footer: () => ({ columns: ['a', { text: UNKNOWN }] }), content: ['a'] },
      ],
      [
        'a table inside a table',
        { content: [{ table: { body: [[{ table: { body: [[UNKNOWN]] } }]] } }] },
      ],
      ['a list inside a column', { content: [{ columns: [{ ul: [{ ol: [UNKNOWN] }] }] }] }],
      ['a stack inside a table cell', { content: [{ table: { body: [[{ stack: [UNKNOWN] }]] } }] }],
      ['a text three levels deep', { content: [{ text: [{ text: [{ text: UNKNOWN }] }] }] }],
      ['a watermark given as a string', { watermark: UNKNOWN, content: ['a'] }],
      ['the page background', { background: { text: UNKNOWN }, content: ['a'] }],
      ['the page background, as a string', { background: UNKNOWN, content: ['a'] }],
      [
        'the page background, as a function',
        { background: () => ({ text: UNKNOWN }), content: ['a'] },
      ],
      [
        'the title of a table of contents',
        {
          content: [
            { toc: { title: { text: `Sadržaj ${UNKNOWN}` } } },
            { text: 'Naslov', tocItem: true },
          ],
        },
      ],
      [
        'a text drawn inside an SVG image',
        {
          content: [
            {
              svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="0" y="20">${UNKNOWN}</text></svg>`,
            },
          ],
        },
      ],
    ];

    it.each(cases)('%s', async (_name, definition) => {
      await expect(renderer.render(definition)).rejects.toThrow(MissingGlyphError);
    });

    it('and what an unchecked character becomes is never printed: no empty glyph in any PDF made here', async () => {
      // Whatever the renderer lets through must still read back complete. An unknown
      // character that slips past the check is drawn with the empty glyph of the font
      // and reads back as U+0000.
      for (const [name, definition] of cases) {
        const pdf = await renderer.render(definition).catch(() => undefined);
        if (pdf !== undefined) {
          const text = linesOf(await readPdf(pdf)).join('\n');
          expect({ name, emptyGlyph: text.includes('\u0000') }).toEqual({
            name,
            emptyGlyph: false,
          });
        }
      }
    });
  });

  describe('Serbian text is drawn with an embedded font, wherever a layout puts it', () => {
    it.each<[string, (text: string) => PdfDocument]>([
      ['the page background', (text) => ({ background: { text }, content: ['a'] })],
      [
        'the title of a table of contents',
        (text) => ({
          content: [{ toc: { title: { text } } }, { text: 'Naslov', tocItem: true }],
        }),
      ],
    ])('%s', async (_name, build) => {
      const text = 'Pozadina šđčćž ŠĐČĆŽ';
      const pdf = await renderer.render(build(text));
      const lines = linesOf(await readPdf(pdf));
      expect(lines.some((line) => line.includes(text))).toBe(true);
      for (const name of rawFontNames(pdf)) {
        expect(name).toMatch(/^[A-Z]{6}\+(Manrope|NotoSans)-(Regular|Bold)$/);
      }
    });
  });
});
