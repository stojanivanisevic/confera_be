import { BILINGUAL_SAMPLE, BILINGUAL_SAMPLE_LINES } from './__fixtures__/bilingual-sample';
import { withFonts } from './document-fonts';
import { FALLBACK_FONT, PRIMARY_FONT } from './fonts';
import { GlyphCoverage, MissingGlyphError } from './glyph-coverage';
import { type PdfDocument, PdfRenderer } from './pdf-renderer';
import { embeddedFontPrograms, linesOf, rawFontNames, readPdf } from './testing/read-pdf';

/**
 * The pdfmake spike (M1-BE-05, ADR-16), on real generated PDF files:
 *
 * - golden text extraction: the text read back from the PDF equals the input, with
 *   š č ć ž đ, Cyrillic and the letters that need the fallback font;
 * - the fonts are embedded;
 * - a character that no font has stops the render with a message;
 * - a render ends in bounded time (the 5 seconds of NFR-PERF-03 are judged in test/timing).
 *
 * The gate of that last criterion, the first document of a process included, is
 * test/timing/pdf-cold-start.spec.ts: fresh processes of plain Node, which is what a
 * server is, with no other test beside them. Here the clock also measures Jest and the
 * machine: the PDF library runs in Jest's sandbox, at the same time as the other test
 * files. Measured on the development laptop, a table of 200 rows takes 0.1 s in plain
 * Node, 0.25 s when this file runs alone, 0.5 to 3 s when the whole unit tier runs on all
 * processors, and the first document of this file came close to 5 seconds, and twice
 * beyond, while browser tests of the frontend ran on the same machine. So the times are
 * reported here and judged there: the next documents and the table of 200 rows too, which
 * took 6.3 to 7.2 s here on a loaded machine in the blank-slate run of 0.3.0 and failed
 * `check` (README, section 8). Here only a bound that a hang could not meet.
 */

/** Not the gate of NFR-PERF-03 (that is test/timing): a guard against a hang. */
const GUARD_MS = 30_000;

describe('PDF generation with pdfmake and embedded fonts', () => {
  jest.setTimeout(120_000);

  const renderer = new PdfRenderer();
  let sample: Buffer;
  /** Loading the PDF library and the fonts: once per process, part of firstDocumentMs. */
  let warmUpMs: number;
  /** From the first use of the renderer to the bytes of the first document. */
  let firstDocumentMs: number;

  beforeAll(async () => {
    const started = performance.now();
    renderer.warmUp();
    warmUpMs = performance.now() - started;
    sample = await renderer.render(BILINGUAL_SAMPLE);
    firstDocumentMs = performance.now() - started;
  });

  describe('the bilingual sample', () => {
    it('is a PDF', () => {
      expect(sample.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(sample.subarray(-6).toString('latin1')).toContain('%%EOF');
      expect(sample.length).toBeGreaterThan(5000);
    });

    it('the extracted text equals the input, line by line (golden test)', async () => {
      const content = await readPdf(sample);
      expect(content.pages).toHaveLength(1);
      expect(linesOf(content)).toEqual(BILINGUAL_SAMPLE_LINES);
    });

    it('the input holds what the spike is about', () => {
      const text = BILINGUAL_SAMPLE_LINES.join('\n');
      for (const letter of 'šđčćžŠĐČĆŽ') {
        expect(text).toContain(letter);
      }
      // Serbian Cyrillic, the digraph letters and polytonic Greek.
      for (const letter of ['Ђ', 'Љ', 'Њ', 'Џ', 'Ћ', 'ǅ', 'ǈ', 'ǌ', 'Ἀ']) {
        expect(text).toContain(letter);
      }
      // Both languages.
      expect(text).toContain('Predračun');
      expect(text).toContain('Proforma invoice');
    });

    it('all its fonts are embedded, as subsets, and are the two families and nothing else', async () => {
      const content = await readPdf(sample);
      expect(content.fonts.length).toBeGreaterThanOrEqual(3);
      for (const font of content.fonts) {
        expect(font).toEqual({ name: font.name, embedded: true });
      }

      const names = rawFontNames(sample);
      expect(names).toEqual([
        expect.stringMatching(/^[A-Z]{6}\+Manrope-Bold$/),
        expect.stringMatching(/^[A-Z]{6}\+Manrope-Regular$/),
        expect.stringMatching(/^[A-Z]{6}\+NotoSans-Regular$/),
      ]);
      // One font program in the file per font, and no reference to a font of the reader's machine.
      expect(embeddedFontPrograms(sample)).toBe(names.length);
      expect(sample.toString('latin1')).not.toMatch(/Helvetica|Times-Roman|Courier|Arial/);
    });

    it('uses the fallback font only for what the primary font lacks', () => {
      const coverage = new GlyphCoverage();
      const fallback = new Set(
        BILINGUAL_SAMPLE_LINES.flatMap((line) => coverage.split(line))
          .filter((run) => run.font === FALLBACK_FONT)
          .flatMap((run) => Array.from(run.text.replaceAll(' ', ''))),
      );
      expect([...fallback].sort()).toEqual(['ǅ', 'ǈ', 'ǌ', 'Ἀ'].sort());
      // š č ć ž đ and Serbian Cyrillic are drawn by the font of the design system.
      for (const letter of 'šđčćžŠĐČĆŽЂЉЊЏЋђљњџћ') {
        expect(coverage.familyOf(letter.codePointAt(0)!)).toBe(PRIMARY_FONT);
      }
    });

    it('renders five times in bounded time, each time reported', async () => {
      const times: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const started = performance.now();
        await renderer.render(BILINGUAL_SAMPLE);
        times.push(performance.now() - started);
      }
      // The 5 seconds, the slowest of five counting (ruling of the test engineer in the
      // verification of 0.1.0), are judged in test/timing (see above); here a guard only.
      expect(Math.max(...times)).toBeLessThan(GUARD_MS);
      // Kept in the test output as the numbers of the spike.
      process.stdout.write(
        `PDF spike, inside Jest: first document ${firstDocumentMs.toFixed(0)} ms (of which library and fonts ${warmUpMs.toFixed(0)} ms), then ${times
          .map((ms) => ms.toFixed(0))
          .join(', ')} ms; ${String(sample.length)} bytes\n`,
      );
    });

    it('does not change the definition it was given', async () => {
      const before = JSON.stringify(BILINGUAL_SAMPLE);
      await renderer.render(BILINGUAL_SAMPLE);
      expect(JSON.stringify(BILINGUAL_SAMPLE)).toBe(before);
    });
  });

  describe('a long document', () => {
    // Far more than a proforma or an invoice will hold: 200 lines on seven pages.
    const ROWS = 200;

    it(`with a table of ${String(ROWS)} rows renders in bounded time and reads back complete`, async () => {
      const rows = Array.from({ length: ROWS }, (_unused, index) => [
        `Stavka ${String(index + 1)}: šđčćž ŠĐČĆŽ`,
        `Item ${String(index + 1)}`,
        `${String(index + 1)},00 RSD`,
      ]);
      const started = performance.now();
      const pdf = await renderer.render({
        content: [
          {
            table: {
              headerRows: 1,
              widths: ['*', 100, 80],
              body: [['Opis', 'Description', 'Iznos'], ...rows],
            },
          },
        ],
      });
      const elapsed = performance.now() - started;
      // The 5 seconds are judged in test/timing (rows200Ms of pdf-cold-start.spec.ts).
      expect(elapsed).toBeLessThan(GUARD_MS);

      const content = await readPdf(pdf);
      expect(content.pages.length).toBeGreaterThan(4);
      const lines = linesOf(content);
      expect(lines).toContain('Stavka 1: šđčćž ŠĐČĆŽ Item 1 1,00 RSD');
      expect(lines).toContain(
        `Stavka ${String(ROWS)}: šđčćž ŠĐČĆŽ Item ${String(ROWS)} ${String(ROWS)},00 RSD`,
      );
      expect(lines.filter((line) => line.startsWith('Stavka '))).toHaveLength(ROWS);
      process.stdout.write(
        `PDF spike: ${String(content.pages.length)} pages, ${String(ROWS)} rows in ${elapsed.toFixed(0)} ms\n`,
      );
    });
  });

  describe('a character that no font has stops the render with a message', () => {
    it.each([
      ['a Chinese character', 'Platilac: 中文 d.o.o.', ['"中" (U+4E2D)', '"文" (U+6587)']],
      ['an Arabic letter', 'Payer: ب', ['"ب" (U+0628)']],
      ['an emoji', 'Hvala 😀', ['"😀" (U+1F600)']],
      ['a zero-width space', 'Novi\u200BSad', ['U+200B']],
      ['a tab', 'Novi\tSad', ['U+0009']],
      ['a private-use character', 'Logo \uE000', ['U+E000']],
    ])('%s', async (_name, text, expected) => {
      const render = renderer.render({ content: [{ text }] });
      await expect(render).rejects.toThrow(MissingGlyphError);
      const error = (await render.catch((caught: unknown) => caught)) as MissingGlyphError;
      expect(error.message).toContain('The PDF cannot be made: no embedded font can print');
      for (const part of expected) {
        expect(error.message).toContain(part);
      }
      expect(error.characters).toHaveLength(expected.length);
    });

    it.each<[string, PdfDocument]>([
      ['a bare string', { content: ['dobro', '中'] }],
      [
        'a nested text',
        { content: [{ text: ['a', { text: ['b', { text: '中', bold: true }] }] }] },
      ],
      ['a table cell', { content: [{ table: { body: [['a', { text: '中' }]] } }] }],
      ['a list item', { content: [{ ul: ['a', { ol: ['中'] }] }] }],
      ['a column', { content: [{ columns: ['a', { stack: ['b', '中'] }] }] }],
      ['a static header', { header: { text: '中' }, content: ['a'] }],
      ['a footer function', { footer: () => ({ text: '中' }), content: ['a'] }],
      ['a watermark', { watermark: { text: 'TEST 中' }, content: ['a'] }],
    ])('wherever it sits: %s', async (_name, definition) => {
      await expect(renderer.render(definition)).rejects.toThrow(MissingGlyphError);
    });

    it('names each missing character once, however often it occurs', () => {
      expect(renderer.missingCharacters('中 中 中 文')).toEqual([
        { character: '中', codePoint: 'U+4E2D' },
        { character: '文', codePoint: 'U+6587' },
      ]);
      expect(renderer.missingCharacters('Živana Đorđević, Ђорђе, ǌ')).toEqual([]);
    });

    it('a watermark must be drawable by the primary font alone', async () => {
      await expect(renderer.render({ watermark: { text: 'ǌ' }, content: ['a'] })).rejects.toThrow(
        MissingGlyphError,
      );
      const pdf = await renderer.render({ watermark: { text: 'TEST / PROBA' }, content: ['a'] });
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  });

  describe('text handling', () => {
    it('composes decomposed letters, so that "s" + caron prints and reads as "š"', async () => {
      const CARON = '\u030C';
      const ACUTE = '\u0301';
      const decomposed = `Z${CARON}ivana c${ACUTE}evap c${CARON}ovek s${CARON}ljiva`;
      expect(decomposed).not.toContain('Ž');
      expect(decomposed.normalize('NFC')).toBe('Živana ćevap čovek šljiva');
      const pdf = await renderer.render({ content: [decomposed] });
      expect(linesOf(await readPdf(pdf))).toEqual(['Živana ćevap čovek šljiva']);
    });

    it.each([
      ['a direction override', 'Uplata \u202Eanuzi\u202C'],
      ['a soft hyphen', 'pred\u00ADračun'],
      ['a zero-width joiner', 'a\u200Db'],
      ['a control character', 'a\u0007b'],
    ])('refuses %s: the text of a document is what a person can see', async (_name, text) => {
      await expect(renderer.render({ content: [text] })).rejects.toThrow(MissingGlyphError);
    });

    it('keeps line breaks inside a text', async () => {
      const pdf = await renderer.render({
        content: [{ text: 'Prvi red: š\r\nDrugi red: đ\nTreći red: ǌ' }],
      });
      expect(linesOf(await readPdf(pdf))).toEqual(['Prvi red: š', 'Drugi red: đ', 'Treći red: ǌ']);
    });

    it('gives every run its font, the fallback font only where the primary one lacks the letter', () => {
      const prepared = withFonts(
        { content: ['samo latinica', { text: 'Ime: ǌegoš i Živana', bold: true }] },
        new GlyphCoverage(),
      ) as { content: unknown[]; defaultStyle: { font: string } };
      expect(prepared.defaultStyle.font).toBe(PRIMARY_FONT);
      // Every piece of text carries its font, so that nothing a layout says about fonts,
      // and no copy pdfmake makes of a text, can draw a letter with a font that lacks it.
      expect(prepared.content[0]).toEqual({
        text: [{ text: 'samo latinica', font: PRIMARY_FONT }],
      });
      expect(prepared.content[1]).toEqual({
        bold: true,
        text: [
          { text: 'Ime: ', font: PRIMARY_FONT },
          { text: 'ǌ', font: FALLBACK_FONT },
          { text: 'egoš i Živana', font: PRIMARY_FONT },
        ],
      });
    });

    it('leaves style names, colours and other settings alone', () => {
      const definition = {
        styles: { 中: { bold: true } },
        content: [{ text: 'a', style: '中', color: '#ff0000', alignment: 'right', id: '中' }],
      };
      expect(() => withFonts(definition, new GlyphCoverage())).not.toThrow();
    });
  });

  describe('a document cannot make the server read a file or call an address', () => {
    it('an image by URL is refused, and nothing is fetched', async () => {
      await expect(
        renderer.render({
          content: [{ image: 'https://example.test/logo.png' }],
        }),
      ).rejects.toThrow();
    });

    it('an image by a local path is refused', async () => {
      await expect(renderer.render({ content: [{ image: 'package.json' }] })).rejects.toThrow();
    });
  });
});
