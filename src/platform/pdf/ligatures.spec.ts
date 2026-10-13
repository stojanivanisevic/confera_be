import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { BILINGUAL_SAMPLE } from './__fixtures__/bilingual-sample';
import { PdfRenderer } from './pdf-renderer';
import { glyphTexts, linesOf, readPdf } from './testing/read-pdf';

/**
 * A finding of the pdfmake spike (M1-BE-05). Manrope joins "fi", "ff" and "tt" into one
 * glyph. pdf.js reads such a glyph back as both letters, but another reader that was
 * tried copied only the first one ("digrafima" came out as "digrafma", "letters" as
 * "leters"). The fonts are therefore loaded without their ligature features (fonts.ts),
 * so that every glyph stands for exactly one character and the text reads back the same
 * in every reader: in content, list markers, page numbers and watermarks alike.
 */

const WORDS = 'Sa digrafima / With digraph letters: office, fjord, affine, kvalifikacija, fluid';

/** A text of one character: one code point, as a single UTF-16 unit or a surrogate pair. */
function isOneCharacter(text: string): boolean {
  return Array.from(text).length === 1;
}

/** The tables of every TrueType font program inside a PDF, by their tags. */
function embeddedFontTables(pdf: Buffer): string[][] {
  // How a TrueType font program starts: with the version 1.0, or with the tag "true".
  const TRUE_TYPE = [0x00010000, 0x74727565];
  const raw = pdf.toString('latin1');
  const fonts: string[][] = [];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    let content: Buffer;
    try {
      content = inflateSync(pdf.subarray(start, raw.indexOf('endstream', start)));
    } catch {
      continue;
    }
    if (content.length < 12 || !TRUE_TYPE.includes(content.readUInt32BE(0))) {
      continue;
    }
    fonts.push(
      Array.from({ length: content.readUInt16BE(4) }, (_unused, index) =>
        content.toString('latin1', 12 + index * 16, 16 + index * 16),
      ),
    );
  }
  return fonts;
}

interface PdfMake {
  readonly virtualfs: { writeFileSync(name: string, content: Buffer): void };
  addFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(definition: object): { getBuffer(): Promise<Buffer> };
}

describe('ligatures are switched off', () => {
  jest.setTimeout(120_000);

  const renderer = new PdfRenderer();

  it('every glyph of a document stands for exactly one character', async () => {
    const pdf = await renderer.render({ content: [WORDS, { text: WORDS, bold: true }] });
    const glyphs = glyphTexts(pdf);
    expect(glyphs.length).toBeGreaterThan(20);
    expect(glyphs.filter((text) => !isOneCharacter(text))).toEqual([]);
    expect(linesOf(await readPdf(pdf))).toEqual([WORDS, WORDS]);
  });

  it('the same holds for the bilingual sample', async () => {
    const glyphs = glyphTexts(await renderer.render(BILINGUAL_SAMPLE));
    expect(glyphs.length).toBeGreaterThan(60);
    expect(glyphs.filter((text) => !isOneCharacter(text))).toEqual([]);
  });

  it('and for what pdfmake writes itself: list markers, a watermark, a table of contents', async () => {
    const pdf = await renderer.render({
      watermark: { text: 'office fluff' },
      content: [
        { toc: { title: { text: 'Sadržaj: affine fjord' } } },
        { text: 'kvalifikacija i affidavit', tocItem: true },
        // Items 162 and 540 of a list counted in letters are "ff" and "tt".
        { ol: ['office'], type: 'lower-alpha', start: 162 },
        { ol: ['letters'], type: 'lower-alpha', start: 540, separator: ')' },
      ],
    });
    const lines = linesOf(await readPdf(pdf));
    // pdfmake draws an item before its marker, and the reader gives the text as drawn.
    expect(lines).toEqual(expect.arrayContaining(['officeff.', 'letterstt)']));
    expect(glyphTexts(pdf).filter((text) => !isOneCharacter(text))).toEqual([]);
  });

  it('the changed feature list stays in the process: a font inside a PDF has no layout tables', async () => {
    const pdf = await renderer.render({ content: [WORDS, { text: WORDS, bold: true }, 'ǌ'] });
    const fonts = embeddedFontTables(pdf);
    expect(fonts).toHaveLength(3);
    for (const tables of fonts) {
      expect(tables).toEqual(expect.arrayContaining(['glyf', 'loca', 'hmtx']));
      expect(tables).not.toContain('GSUB');
      expect(tables).not.toContain('GPOS');
    }
  });

  it('the check sees a ligature when a font is used as it is shipped', async () => {
    // The same PDF library with the unchanged font file: the proof that glyphTexts would
    // find a joined glyph if the renderer drew one.
    renderer.warmUp();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfmake = require('pdfmake') as PdfMake;
    pdfmake.virtualfs.writeFileSync(
      'Shipped.ttf',
      readFileSync(require.resolve('@expo-google-fonts/manrope/400Regular/Manrope_400Regular.ttf')),
    );
    const cut = 'Shipped.ttf';
    pdfmake.addFonts({ Shipped: { normal: cut, bold: cut, italics: cut, bolditalics: cut } });
    const pdf = await pdfmake
      .createPdf({ defaultStyle: { font: 'Shipped' }, content: [WORDS] })
      .getBuffer();
    const joined = glyphTexts(pdf).filter((text) => !isOneCharacter(text));
    expect(joined).toEqual(expect.arrayContaining(['fi', 'tt']));
  });
});
