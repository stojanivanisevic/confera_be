import { BILINGUAL_SAMPLE } from './__fixtures__/bilingual-sample';
import { NO_LIGATURES } from './document-fonts';
import { type PdfDocument, PdfRenderer } from './pdf-renderer';
import { glyphTexts, linesOf, readPdf } from './testing/read-pdf';

/**
 * A finding of the pdfmake spike (M1-BE-05). Manrope joins "fi", "ff" and "tt" into one
 * glyph. pdf.js reads such a glyph back as both letters, but another reader that was
 * tried copied only the first one ("digrafima" came out as "digrafma", "letters" as
 * "leters"). The renderer therefore switches ligatures off, so that every glyph stands
 * for exactly one character and the text reads back the same in every reader.
 */

const WORDS = 'Sa digrafima / With digraph letters: office, fjord, affine, kvalifikacija, fluid';

/** A text of one character: one code point, as a single UTF-16 unit or a surrogate pair. */
function isOneCharacter(text: string): boolean {
  return Array.from(text).length === 1;
}

describe('ligatures are switched off', () => {
  jest.setTimeout(120_000);

  const renderer = new PdfRenderer();

  it('by default, every glyph of a document stands for exactly one character', async () => {
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

  it('the check sees a ligature when a document asks for them', async () => {
    const withLigatures = {
      defaultStyle: { fontFeatures: { liga: true } },
      content: [WORDS],
    } as unknown as PdfDocument;
    const joined = glyphTexts(await renderer.render(withLigatures)).filter(
      (text) => !isOneCharacter(text),
    );
    expect(joined).toEqual(expect.arrayContaining(['fi', 'tt']));
  });

  it('names the features it switches off', () => {
    expect(NO_LIGATURES).toEqual({ liga: false, clig: false, dlig: false, hlig: false });
  });
});
