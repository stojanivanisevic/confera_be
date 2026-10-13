import * as fontkit from 'fontkit';
import { FONT_FAMILIES, type FontFamily, fontFiles } from './fonts';

/**
 * The glyph check (ADR-16, finding SEC-A-39): before a PDF is made, every character of
 * its text is looked up in the embedded fonts.
 *
 * - A character goes to the first family that has it: Manrope, else Noto Sans.
 * - A character that no family has stops the render with a message that names it.
 *   Without this check the PDF library would print an empty box and say nothing.
 */

export interface MissingCharacter {
  /** The character itself. */
  readonly character: string;
  /** For example `U+4E2D`. */
  readonly codePoint: string;
}

export class MissingGlyphError extends Error {
  constructor(readonly characters: readonly MissingCharacter[]) {
    super(
      `The PDF cannot be made: no embedded font can print ${characters.length === 1 ? 'this character' : 'these characters'}: ${characters
        .map(({ character, codePoint }) =>
          character === '' ? codePoint : `"${character}" (${codePoint})`,
        )
        .join(', ')}. Replace or remove ${characters.length === 1 ? 'it' : 'them'} and try again.`,
    );
    this.name = 'MissingGlyphError';
  }
}

/** A stretch of text that one font family can draw. */
export interface FontRun {
  readonly text: string;
  readonly font: FontFamily;
}

/** The only character without a glyph that text may hold: the line break. */
const LINE_BREAK = 0x0a;

/**
 * Characters that print nothing: controls, invisible format characters (zero-width
 * space, direction overrides, soft hyphen), private-use and unassigned code points.
 * Some fonts carry an empty glyph for them; they are refused all the same, so that the
 * text of a document is exactly what a person can see in it.
 */
const UNPRINTABLE = /^[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]$/u;

function describe(codePoint: number): MissingCharacter {
  const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
  // A control or invisible character is shown by its number only.
  const visible = codePoint > 0x20 && !(codePoint >= 0x7f && codePoint <= 0xa0);
  return { character: visible ? String.fromCodePoint(codePoint) : '', codePoint: `U+${hex}` };
}

/** Text as it is checked and drawn: composed characters, and one kind of line break. */
export function normaliseText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}

export class GlyphCoverage {
  private readonly families: readonly { name: FontFamily; has: (codePoint: number) => boolean }[];

  constructor() {
    const files = fontFiles();
    this.families = FONT_FAMILIES.map((name) => {
      // A family covers a character only when every cut that is embedded has it, so that
      // bold text can never fall into a hole the regular cut does not have.
      const { normal, bold, italics, bolditalics } = files[name];
      const paths = [normal, bold, italics, bolditalics];
      const cuts = [...new Set(paths)].map((file) => {
        const font = fontkit.openSync(file);
        if (!('characterSet' in font)) {
          throw new Error(
            `${name}: a font collection cannot be embedded, a single font is needed.`,
          );
        }
        return new Set(font.characterSet);
      });
      return { name, has: (codePoint: number) => cuts.every((cut) => cut.has(codePoint)) };
    });
  }

  /** The family that draws this character, or undefined when none can or it prints nothing. */
  familyOf(codePoint: number): FontFamily | undefined {
    if (UNPRINTABLE.test(String.fromCodePoint(codePoint))) {
      return undefined;
    }
    return this.families.find((family) => family.has(codePoint))?.name;
  }

  /** Every character of the text that no embedded font has. Each one once. */
  missing(text: string): MissingCharacter[] {
    const missing = new Map<number, MissingCharacter>();
    for (const character of normaliseText(text)) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint !== LINE_BREAK && this.familyOf(codePoint) === undefined) {
        missing.set(codePoint, describe(codePoint));
      }
    }
    return [...missing.values()];
  }

  /**
   * Splits a text into runs, each drawn by one family. Throws MissingGlyphError when a
   * character has no font. A line break stays in the run it is in.
   */
  split(text: string): FontRun[] {
    const normalised = normaliseText(text);
    const missing = this.missing(normalised);
    if (missing.length > 0) {
      throw new MissingGlyphError(missing);
    }
    const runs: { text: string; font: FontFamily }[] = [];
    for (const character of normalised) {
      const codePoint = character.codePointAt(0) ?? 0;
      const last = runs.at(-1);
      // A line break and a space take the font of the text around them.
      const font =
        codePoint === LINE_BREAK
          ? (last?.font ?? FONT_FAMILIES[0])
          : (this.familyOf(codePoint) ?? FONT_FAMILIES[0]);
      const neutral = codePoint === LINE_BREAK || codePoint === 0x20;
      if (last !== undefined && (last.font === font || neutral)) {
        last.text += character;
      } else {
        runs.push({ text: character, font });
      }
    }
    return runs;
  }
}
