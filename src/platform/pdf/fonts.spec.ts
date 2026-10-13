import { readFileSync } from 'node:fs';
import * as fontkit from 'fontkit';
import { FONT_FAMILIES, loadFonts, withoutLigatures } from './fonts';

/**
 * The embedded fonts, read once and with their ligatures switched off (ADR-16; defect D4
 * of the 0.1.0 verification: asking for "no ligatures" per text made a long table three
 * to four times slower, because the PDF library then lays out every text without its
 * cache).
 */

type Font = fontkit.Font;

function open(data: Buffer): Font {
  const font = fontkit.create(data);
  if (!('layout' in font)) {
    throw new Error('not a single font');
  }
  return font;
}

/** The original file of a cut, as the package ships it. */
function original(family: string, cut: string): Buffer {
  const files: Record<string, string> = {
    'Manrope-normal': '@expo-google-fonts/manrope/400Regular/Manrope_400Regular.ttf',
    'Manrope-bold': '@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf',
    'NotoSans-normal': '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
    'NotoSans-bold': '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf',
  };
  return readFileSync(require.resolve(files[`${family}-${cut}`] ?? ''));
}

/** True when the layout engine draws the text with one glyph per character. */
function oneGlyphPerCharacter(font: Font, text: string): boolean {
  const { glyphs } = font.layout(text);
  return (
    glyphs.length === Array.from(text).length &&
    glyphs.every((glyph) => glyph.codePoints.length === 1)
  );
}

const LIGATURE_FEATURES = ['liga', 'clig', 'dlig', 'hlig'];
const ALPHABET = Array.from('abcdefghijklmnopqrstuvwxyzšđčćž-.,:;/()0123456789');

describe('embedded fonts', () => {
  jest.setTimeout(120_000);

  const fonts = loadFonts();

  it('are two cuts of each of the two families, each under its own name', () => {
    expect(fonts.map((font) => font.name)).toEqual([
      'Manrope-normal.ttf',
      'Manrope-bold.ttf',
      'NotoSans-normal.ttf',
      'NotoSans-bold.ttf',
    ]);
    expect(new Set(fonts.map((font) => font.family))).toEqual(new Set(FONT_FAMILIES));
  });

  describe.each(fonts.map((font) => [font.name, font] as const))('%s', (_name, font) => {
    const before = original(font.family, font.cut);
    const shipped = open(before);
    const loaded = open(font.data);

    it('as shipped joins letters into one glyph, which is why this exists', () => {
      expect(shipped.availableFeatures).toContain('liga');
      expect(oneGlyphPerCharacter(shipped, 'fi')).toBe(false);
    });

    it('as loaded has no ligature feature', () => {
      for (const feature of LIGATURE_FEATURES) {
        expect(loaded.availableFeatures).not.toContain(feature);
      }
    });

    it('as loaded keeps every other feature of the font', () => {
      const others = shipped.availableFeatures.filter((tag) => !LIGATURE_FEATURES.includes(tag));
      expect(others).toEqual(expect.arrayContaining(['kern']));
      for (const feature of others) {
        expect(loaded.availableFeatures).toContain(feature);
      }
    });

    it('as loaded draws every pair of letters with two glyphs', () => {
      const joined: string[] = [];
      for (const first of ALPHABET) {
        for (const second of ALPHABET) {
          if (!oneGlyphPerCharacter(loaded, first + second)) {
            joined.push(first + second);
          }
        }
      }
      expect(joined).toEqual([]);
    });

    it.each(['ffi', 'ffl', 'fft', 'ttt', '---', 'office', 'kvalifikacija', 'Šefflera'])(
      'as loaded draws "%s" with one glyph per letter',
      (text) => {
        expect(oneGlyphPerCharacter(loaded, text)).toBe(true);
      },
    );

    it('differs from the shipped file in the feature tags only', () => {
      expect(font.data.length).toBe(before.length);
      const changed: number[] = [];
      for (let index = 0; index < before.length; index += 1) {
        if (before[index] !== font.data[index]) {
          changed.push(index);
        }
      }
      // Four bytes per renamed feature record, each now the letter "z", and nothing else.
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.length % 4).toBe(0);
      expect(changed.every((index) => font.data[index] === 'z'.charCodeAt(0))).toBe(true);
      // Same letters, same shapes, same widths.
      expect(loaded.characterSet).toEqual(shipped.characterSet);
      expect(loaded.numGlyphs).toBe(shipped.numGlyphs);
      for (const letter of 'šđčćžŠĐČĆŽAaWw') {
        const codePoint = letter.codePointAt(0) ?? 0;
        expect(loaded.glyphForCodePoint(codePoint).advanceWidth).toBe(
          shipped.glyphForCodePoint(codePoint).advanceWidth,
        );
      }
    });
  });

  describe('withoutLigatures', () => {
    it('returns a copy and leaves its argument alone', () => {
      const before = original('Manrope', 'normal');
      const snapshot = Buffer.from(before);
      const after = withoutLigatures(before);
      expect(after).not.toBe(before);
      expect(before.equals(snapshot)).toBe(true);
      expect(after.equals(before)).toBe(false);
    });

    it('applied twice changes nothing more', () => {
      const once = withoutLigatures(original('NotoSans', 'bold'));
      expect(withoutLigatures(once).equals(once)).toBe(true);
    });
  });
});
