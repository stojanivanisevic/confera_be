import * as fontkit from 'fontkit';
import { FONT_FAMILIES, type FontFamily, type LoadedFont, loadFonts } from './fonts';

/**
 * The glyph check (ADR-16, finding SEC-A-39): before a PDF is made, every character of
 * its text is looked up in the embedded fonts.
 *
 * - A character goes to the first family that has it: Manrope, else Noto Sans.
 * - A character that no family has stops the render with a message that names it.
 *   Without this check the PDF library would print an empty box and say nothing.
 */

export interface MissingCharacter {
  /** The character itself; empty for a character that cannot be seen. */
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

/** Which fonts must have a character. */
export type Requirement =
  /** Any family: the text is split into runs, each drawn by the family that has it. */
  | 'any'
  /** The primary family: for text that is drawn in one font and cannot be split. */
  | 'primary'
  /**
   * Every family: for text whose font is decided by the PDF library from the styles
   * around it (the separator of a numbered list), so that it prints whichever is used.
   */
  | 'every';

/** The only character without a glyph that text may hold: the line break. */
const LINE_BREAK = 0x0a;
const SPACE = 0x20;

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
  const visible = codePoint > SPACE && !UNPRINTABLE.test(String.fromCodePoint(codePoint));
  return { character: visible ? String.fromCodePoint(codePoint) : '', codePoint: `U+${hex}` };
}

/** Text as it is checked and drawn: composed characters, and one kind of line break. */
export function normaliseText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}

interface Family {
  readonly name: FontFamily;
  /** Code points that EVERY embedded cut of the family has. */
  readonly characters: ReadonlySet<number>;
}

export class GlyphCoverage {
  private readonly families: readonly Family[];
  /** Per code point: the family that draws it, or null. Filled as text is seen. */
  private readonly known = new Map<number, FontFamily | null>();

  constructor(fonts: readonly LoadedFont[] = loadFonts()) {
    this.families = FONT_FAMILIES.map((name) => {
      // A family covers a character only when every cut that is embedded has it, so that
      // bold text can never fall into a hole the regular cut does not have.
      const cuts = fonts
        .filter((font) => font.family === name)
        .map((font) => {
          const opened = fontkit.create(font.data);
          if (!('characterSet' in opened)) {
            throw new Error(`${font.name}: a font collection cannot be embedded.`);
          }
          return new Set(opened.characterSet);
        });
      const [first, ...rest] = cuts;
      if (first === undefined) {
        throw new Error(`No font file was loaded for the family ${name}.`);
      }
      const characters = new Set(
        [...first].filter((codePoint) => rest.every((cut) => cut.has(codePoint))),
      );
      return { name, characters };
    });
  }

  /** The family that draws this character, or undefined when none can or it prints nothing. */
  familyOf(codePoint: number): FontFamily | undefined {
    let family = this.known.get(codePoint);
    if (family === undefined) {
      family = UNPRINTABLE.test(String.fromCodePoint(codePoint))
        ? null
        : (this.families.find(({ characters }) => characters.has(codePoint))?.name ?? null);
      this.known.set(codePoint, family);
    }
    return family ?? undefined;
  }

  private printable(codePoint: number, requirement: Requirement): boolean {
    if (codePoint === LINE_BREAK) {
      return true;
    }
    const family = this.familyOf(codePoint);
    if (family === undefined) {
      return false;
    }
    if (requirement === 'any') {
      return true;
    }
    if (requirement === 'primary') {
      return family === FONT_FAMILIES[0];
    }
    return this.families.every(({ characters }) => characters.has(codePoint));
  }

  /** Every character of the text that the required fonts cannot print. Each one once. */
  missing(text: string, requirement: Requirement = 'any'): MissingCharacter[] {
    const missing = new Map<number, MissingCharacter>();
    for (const character of normaliseText(text)) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (!this.printable(codePoint, requirement)) {
        missing.set(codePoint, describe(codePoint));
      }
    }
    return [...missing.values()];
  }

  /** Throws MissingGlyphError unless the required fonts can print all of the text. */
  require(text: string, requirement: Requirement): string {
    const normalised = normaliseText(text);
    const missing = this.missing(normalised, requirement);
    if (missing.length > 0) {
      throw new MissingGlyphError(missing);
    }
    return normalised;
  }

  /**
   * Splits a text into runs, each drawn by one family. Throws MissingGlyphError when a
   * character has no font. A line break and a space stay in the run they follow.
   */
  split(text: string): FontRun[] {
    const normalised = normaliseText(text);
    const runs: { text: string; font: FontFamily }[] = [];
    let missing: Map<number, MissingCharacter> | undefined;
    for (const character of normalised) {
      const codePoint = character.codePointAt(0) ?? 0;
      const last = runs.at(-1);
      const neutral = codePoint === LINE_BREAK || codePoint === SPACE;
      const family = neutral && last !== undefined ? last.font : this.familyOf(codePoint);
      if (family === undefined) {
        if (codePoint === LINE_BREAK) {
          runs.push({ text: character, font: FONT_FAMILIES[0] });
        } else {
          (missing ??= new Map()).set(codePoint, describe(codePoint));
        }
      } else if (last?.font === family) {
        last.text += character;
      } else {
        runs.push({ text: character, font: family });
      }
    }
    if (missing !== undefined) {
      throw new MissingGlyphError([...missing.values()]);
    }
    return runs;
  }
}
