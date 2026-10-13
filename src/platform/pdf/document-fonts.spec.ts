import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  REFUSED_DEFINITION_KEYS,
  REFUSED_NODE_KINDS,
  SUPPORTED_DEFINITION_KEYS,
  SUPPORTED_NODE_KINDS,
  UnsupportedPdfFeatureError,
  withFonts,
} from './document-fonts';
import { FALLBACK_FONT, PRIMARY_FONT } from './fonts';
import { GlyphCoverage, MissingGlyphError } from './glyph-coverage';
import { type PdfDocument, PdfRenderer } from './pdf-renderer';
import { linesOf, rawFontNames, readPdf } from './testing/read-pdf';

/**
 * The walk over a document definition (ADR-16; defect D3 of the 0.1.0 verification: a
 * character without a font, placed in the page background, in the title of a table of
 * contents or in SVG text, was printed as an empty glyph and nobody was told).
 *
 * The glyph check must cover every place where text can enter a document. The walk is
 * therefore an allowlist: it knows every kind of node and every property of a definition
 * that pdfmake has, checks the text of those it accepts, and refuses the rest.
 */

const UNKNOWN = '中';
const coverage = new GlyphCoverage();

function prepare(definition: object): Record<string, unknown> {
  return withFonts(definition, coverage) as Record<string, unknown>;
}

const P = (text: string) => ({ text, font: PRIMARY_FONT });
const F = (text: string) => ({ text, font: FALLBACK_FONT });

describe('the document walk', () => {
  describe('knows what pdfmake has', () => {
    const pdfmake = dirname(require.resolve('pdfmake'));
    const source = (file: string) => readFileSync(join(pdfmake, file), 'utf8');

    it('every kind of node of this version of pdfmake is either accepted or refused by name', () => {
      // The chain of `if (node.<kind>)` in which pdfmake decides what a node is.
      const preprocessor = source('DocPreprocessor.js');
      const chain = preprocessor.slice(
        preprocessor.indexOf('preprocessNode(node,'),
        preprocessor.indexOf('Unrecognized document structure'),
      );
      const kinds = new Set(
        [...chain.matchAll(/(?:if \(|\|\| )node\.([A-Za-z]+)\b/g)].map((match) => match[1] ?? ''),
      );
      expect(kinds.size).toBe(15);
      expect([...kinds].sort()).toEqual(
        [...SUPPORTED_NODE_KINDS, ...Object.keys(REFUSED_NODE_KINDS)].sort(),
      );
    });

    it('every property of a document definition is either accepted or refused by name', () => {
      const printer = source('Printer.js');
      const properties = new Set(
        [...printer.matchAll(/docDefinition\.([A-Za-z]+)\b/g)].map((match) => match[1] ?? ''),
      );
      expect(properties.size).toBeGreaterThan(20);
      expect([...properties].sort()).toEqual(
        [...SUPPORTED_DEFINITION_KEYS, ...Object.keys(REFUSED_DEFINITION_KEYS)].sort(),
      );
    });

    it('is pinned to the version these lists were read from', () => {
      const manifest = JSON.parse(source(join('..', 'package.json'))) as { version: string };
      expect(manifest.version).toBe('0.3.11');
    });
  });

  describe('gives every text its font', () => {
    it.each<[string, unknown, unknown]>([
      ['a string', 'Živana', { text: [P('Živana')] }],
      ['a number', 12, { text: [P('12')] }],
      ['a boolean', true, { text: [P('true')] }],
      ['an empty string', '', { text: [] }],
      ['a text node', { text: 'Živana', bold: true }, { text: [P('Živana')], bold: true }],
      [
        'a text of pieces',
        { text: ['a', 5, { text: 'b', bold: true }] },
        { text: [P('a'), P('5'), { text: [P('b')], bold: true }] },
      ],
      ['a text object as the text', { text: { text: 'a' } }, { text: [{ text: [P('a')] }] }],
      ['letters of the fallback font', 'aǌb', { text: [P('a'), F('ǌ'), P('b')] }],
      ['a stack', { stack: ['a', ['b']] }, { stack: [{ text: [P('a')] }, [{ text: [P('b')] }]] }],
      [
        'columns',
        { columns: ['a', { text: 'ǌ' }] },
        { columns: [{ text: [P('a')] }, { text: [F('ǌ')] }] },
      ],
      ['a bulleted list', { ul: ['a'] }, { ul: [{ text: [P('a')] }] }],
      [
        'a numbered list',
        { ol: ['a'], separator: ')' },
        { ol: [{ text: [P('a')] }], separator: ')' },
      ],
      [
        'a table',
        {
          table: {
            widths: ['*'],
            body: [
              ['a', {}],
              [null, 7],
            ],
          },
        },
        {
          table: {
            widths: ['*'],
            body: [
              [{ text: [P('a')] }, {}],
              [null, { text: [P('7')] }],
            ],
          },
        },
      ],
      [
        'a table of contents',
        { toc: { title: { text: 'Sadržaj' } } },
        { toc: { title: { text: [P('Sadržaj')] } } },
      ],
      [
        'a page reference',
        { text: ['strana ', { pageReference: 'x' }] },
        { text: [P('strana '), { pageReference: 'x' }] },
      ],
      [
        'an image, a drawing and a QR code',
        [{ image: 'logo' }, { canvas: [] }, { qr: UNKNOWN }],
        [{ image: 'logo' }, { canvas: [] }, { qr: UNKNOWN }],
      ],
    ])('%s', (_name, content, expected) => {
      expect(prepare({ content }).content).toEqual(expected);
    });

    it('in the header, the footer and the background, static or as a function', () => {
      const prepared = prepare({
        header: 'Zaglavlje',
        footer: (page: number) => ({ text: `Strana ${String(page)}` }),
        background: () => ['Pozadina ǌ'],
        content: [],
      });
      expect(prepared.header).toEqual({ text: [P('Zaglavlje')] });
      expect((prepared.footer as (page: number) => unknown)(3)).toEqual({ text: [P('Strana 3')] });
      expect((prepared.background as () => unknown)()).toEqual([
        { text: [P('Pozadina '), F('ǌ')] },
      ]);
    });

    it('a watermark gets the primary font, whatever the layout asked for', () => {
      expect(prepare({ watermark: 'PROBA', content: [] }).watermark).toEqual({
        text: 'PROBA',
        font: PRIMARY_FONT,
      });
      expect(
        prepare({ watermark: { text: 'TEST', font: FALLBACK_FONT, opacity: 0.2 }, content: [] })
          .watermark,
      ).toEqual({ text: 'TEST', font: PRIMARY_FONT, opacity: 0.2 });
    });

    it('the font of a letter does not depend on what the layout says about fonts', () => {
      const prepared = prepare({
        defaultStyle: { font: FALLBACK_FONT, fontSize: 9 },
        styles: { odd: { font: FALLBACK_FONT } },
        content: [{ text: '∑ in Manrope only, ǌ in Noto only', font: FALLBACK_FONT, style: 'odd' }],
      });
      expect(prepared.defaultStyle).toEqual({ font: PRIMARY_FONT, fontSize: 9 });
      expect(prepared.content).toEqual([
        {
          font: FALLBACK_FONT,
          style: 'odd',
          // A space stays in the run it follows.
          text: [P('∑ in Manrope only, '), F('ǌ '), P('in Noto only')],
        },
      ]);
    });

    it('does not change the definition it was given', () => {
      const definition = {
        header: { text: 'a' },
        watermark: 'b',
        content: [{ table: { body: [['c', { ul: ['d'] }]] } }, { toc: { title: 'e' } }],
      };
      const before = JSON.stringify(definition);
      prepare(definition);
      expect(JSON.stringify(definition)).toBe(before);
    });
  });

  describe('a character that no font has stops the walk, wherever it sits', () => {
    it.each<[string, object]>([
      ['a string', { content: UNKNOWN }],
      ['a text three levels deep', { content: [{ text: [{ text: [{ text: UNKNOWN }] }] }] }],
      ['a text object as the text', { content: [{ text: { text: UNKNOWN } }] }],
      [
        'a stack inside columns inside a list',
        { content: [{ ul: [{ columns: [{ stack: [UNKNOWN] }] }] }] },
      ],
      [
        'a table inside a table',
        { content: [{ table: { body: [[{ table: { body: [[UNKNOWN]] } }]] } }] },
      ],
      ['the title of a table of contents', { content: [{ toc: { title: { text: UNKNOWN } } }] }],
      ['the title of a table of contents, as a string', { content: [{ toc: { title: UNKNOWN } }] }],
      ['the separator of a numbered list', { content: [{ ol: ['a'], separator: UNKNOWN }] }],
      ['one of two separators', { content: [{ ol: ['a'], separator: ['(', UNKNOWN] }] }],
      ['a static header', { header: UNKNOWN, content: [] }],
      ['a static footer', { footer: { columns: ['a', UNKNOWN] }, content: [] }],
      ['the page background', { background: { text: UNKNOWN }, content: [] }],
      ['the page background, as a string', { background: UNKNOWN, content: [] }],
      ['the page background, as a list', { background: ['a', [UNKNOWN]], content: [] }],
      ['a watermark', { watermark: { text: UNKNOWN }, content: [] }],
      ['a watermark, as a string', { watermark: UNKNOWN, content: [] }],
      ['text inside an SVG image', { content: [{ svg: `<svg><text>${UNKNOWN}</text></svg>` }] }],
      [
        'an SVG character reference in decimal',
        { content: [{ svg: '<svg><text>&#20013;</text></svg>' }] },
      ],
      [
        'an SVG character reference in hexadecimal',
        { content: [{ svg: '<svg><text>&#x4E2D;</text></svg>' }] },
      ],
      [
        'an SVG character reference beyond Unicode',
        { content: [{ svg: '<svg><text>&#x110000;</text></svg>' }] },
      ],
      [
        'a text node that is also another kind of node',
        { content: [{ image: 'logo', text: UNKNOWN }] },
      ],
    ])('%s', (_name, definition) => {
      expect(() => prepare(definition)).toThrow(MissingGlyphError);
    });

    it.each<[string, (page: number) => unknown, 'header' | 'footer' | 'background']>([
      ['a header function', () => UNKNOWN, 'header'],
      ['a footer function', () => ({ columns: [{ text: UNKNOWN }] }), 'footer'],
      ['a background function', () => [{ text: UNKNOWN }], 'background'],
    ])('%s, when pdfmake calls it for a page', (_name, build, key) => {
      const prepared = prepare({ [key]: build, content: [] });
      expect(() => (prepared[key] as (page: number) => unknown)(1)).toThrow(MissingGlyphError);
    });

    it('letters that only the fallback font has are refused where the text cannot be split', () => {
      // A watermark and the separator of a list are drawn in one font.
      expect(() => prepare({ watermark: 'ǌ', content: [] })).toThrow(MissingGlyphError);
      expect(() => prepare({ content: [{ ol: ['a'], separator: '∑' }] })).toThrow(
        MissingGlyphError,
      );
    });

    it('everything pdfmake writes by itself is in both families', () => {
      // Numbers of pages and of list items, in digits, letters and Roman numerals, and the
      // printable ASCII characters of a separator.
      const ascii = Array.from({ length: 0x7f - 0x20 }, (_unused, index) =>
        String.fromCodePoint(0x20 + index),
      ).join('');
      expect(coverage.missing(ascii, 'every')).toEqual([]);
    });
  });

  describe('refuses what it cannot check', () => {
    it.each(Object.keys(REFUSED_NODE_KINDS))('a "%s" node', (kind) => {
      expect(() => prepare({ content: [{ [kind]: kind === 'section' ? ['a'] : 'a' }] })).toThrow(
        UnsupportedPdfFeatureError,
      );
    });

    it('an SVG image whose text is fine is refused all the same, and says why', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="20">Šta</text></svg>';
      expect(() => prepare({ content: [{ svg }] })).toThrow(/"svg" node is not supported.*<image>/);
    });

    it.each<[string, object]>([
      ['a kind of node it does not know', { content: [{ hologram: 'a' }] }],
      ['a node of another kind inside a text', { content: [{ text: [{ image: 'logo' }] }] }],
      ['a refused kind inside a text', { content: [{ text: [{ textReference: 'x' }] }] }],
      ['a function as content', { content: [() => 'a'] }],
      ['a function as a text', { content: [{ text: () => 'a' }] }],
      ['a list that is not a list', { content: [{ ul: 'a' }] }],
      ['a table without rows', { content: [{ table: { widths: ['*'] } }] }],
      ['a row that is not a list', { content: [{ table: { body: ['a'] } }] }],
      ['a sorted table of contents', { content: [{ toc: { sortBy: 'title' } }] }],
      ['a watermark that is not a text', { watermark: { text: ['a'] }, content: [] }],
      ['a property of a definition it does not know', { content: [], hologram: true }],
      ['files attached to the PDF', { content: [], attachments: {} }],
      ['files for the PDF', { content: [], files: {} }],
      ['a fill pattern in raw PDF code', { content: [], patterns: {} }],
    ])('%s', (_name, definition) => {
      expect(() => prepare(definition)).toThrow(UnsupportedPdfFeatureError);
    });

    it('names the feature and the reason', () => {
      expect(() => prepare({ content: [{ hologram: 'a', depth: 3 }] })).toThrow(
        'The PDF cannot be made: a node with the properties hologram, depth is not supported by the PDF renderer.',
      );
    });
  });
});

describe('rendered documents', () => {
  jest.setTimeout(120_000);

  const renderer = new PdfRenderer();
  const text = 'Pozadina šđčćž ŠĐČĆŽ ǌ';

  async function read(definition: PdfDocument) {
    const pdf = await renderer.render(definition);
    const lines = linesOf(await readPdf(pdf));
    return { pdf, lines, all: lines.join('\n') };
  }

  it('text in the page background reads back, in embedded fonts', async () => {
    const { pdf, lines } = await read({ background: { text }, content: ['a'] });
    expect(lines).toContain(text);
    for (const name of rawFontNames(pdf)) {
      expect(name).toMatch(/^[A-Z]{6}\+(Manrope|NotoSans)-(Regular|Bold)$/);
    }
  });

  it('a table of contents copies its entries with their fonts', async () => {
    const { lines, all } = await read({
      content: [
        { toc: { title: { text: 'Sadržaj šđčćž' } } },
        { text: 'Poglavlje ǅemal ǈubica ǌegoš', tocItem: true, pageBreak: 'before' },
      ],
    });
    expect(lines).toContain('Sadržaj šđčćž');
    // Once in the table of contents, with its page number, and once on its page.
    expect(lines.filter((line) => line.startsWith('Poglavlje ǅemal ǈubica ǌegoš'))).toHaveLength(2);
    expect(all).not.toContain(String.fromCodePoint(0));
  });

  it('a numbered list prints its numbers and separators', async () => {
    const { lines } = await read({
      content: [
        { ol: ['prvi šđ', 'drugi čć'], separator: ['(', ')'] },
        { ol: ['treći ž'], type: 'upper-roman', start: 4 },
      ],
    });
    // pdfmake draws an item before its number, and the reader gives the text as drawn.
    expect(lines).toEqual(['prvi šđ(1)', 'drugi čć(2)', 'treći žIV.']);
  });

  describe('the fonts are read from memory, so no path on the disk is open to a document', () => {
    // A real picture of one pixel: as data it is drawn, so a refusal below is about the
    // path and not about the picture.
    const PIXEL =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const directory = mkdtempSync(join(tmpdir(), 'confera-pdf-image-'));
    const file = join(directory, 'pixel.png');
    const DENIED = /denied by resource access policy/;

    beforeAll(() => {
      writeFileSync(file, Buffer.from(PIXEL, 'base64'));
    });
    afterAll(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('a picture given as data is drawn', async () => {
      const image = `data:image/png;base64,${PIXEL}`;
      const pdf = await renderer.render({ content: [{ image, width: 10 }] });
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.toString('latin1')).toContain('/Subtype /Image');
    });

    it('the same picture by its path is refused', async () => {
      await expect(renderer.render({ content: [{ image: file, width: 10 }] })).rejects.toThrow(
        DENIED,
      );
      await expect(
        renderer.render({ images: { logo: file }, content: [{ image: 'logo', width: 10 }] }),
      ).rejects.toThrow(DENIED);
    });

    it.each(['package.json', '.env', join('..', 'package.json')])(
      'the path "%s" is refused',
      async (image) => {
        await expect(renderer.render({ content: [{ image }] })).rejects.toThrow(DENIED);
      },
    );

    it('a font file of the renderer is refused too: fonts do not come from paths', async () => {
      const font = require.resolve('@expo-google-fonts/manrope/400Regular/Manrope_400Regular.ttf');
      await expect(renderer.render({ content: [{ image: font }] })).rejects.toThrow(DENIED);
    });
  });

  it('an SVG image cannot make the renderer open a file', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="package.json" width="10" height="10"/></svg>`;
    await expect(renderer.render({ content: [{ svg }] })).rejects.toThrow(
      UnsupportedPdfFeatureError,
    );
  });
});
