import { readFileSync } from 'node:fs';

/**
 * The fonts that every Confera PDF embeds (ADR-16).
 *
 * - Manrope is the typeface of the UdEkoM design system. It covers Serbian Latin
 *   (š č ć ž đ), Serbian Cyrillic and monotonic Greek.
 * - Noto Sans is the fallback for what Manrope lacks: the digraph letters ǆ ǉ ǌ,
 *   polytonic Greek, extended Cyrillic and Latin. A payer's name may use them.
 *
 * Both are under the SIL Open Font License 1.1 and come as complete TrueType files from
 * the packages @expo-google-fonts/manrope and @expo-google-fonts/noto-sans, pinned and
 * checked by the lockfile like every dependency. Nothing is downloaded at run time.
 *
 * The files are read once per process and handed to the PDF library from memory, with
 * their ligatures switched off (see `withoutLigatures`).
 *
 * Neither family has an italic cut here, so italics map to the upright cuts: a layout
 * that asks for italics gets upright text instead of an error.
 */
export const PRIMARY_FONT = 'Manrope';
export const FALLBACK_FONT = 'NotoSans';

/** Order matters: a character goes to the first family that has it. */
export const FONT_FAMILIES = [PRIMARY_FONT, FALLBACK_FONT] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export const FONT_CUTS = ['normal', 'bold'] as const;
export type FontCut = (typeof FONT_CUTS)[number];

/** Where each cut of each family is, inside its package. */
const FONT_PACKAGE_FILES: Readonly<Record<FontFamily, Readonly<Record<FontCut, string>>>> = {
  Manrope: {
    normal: '@expo-google-fonts/manrope/400Regular/Manrope_400Regular.ttf',
    bold: '@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf',
  },
  NotoSans: {
    normal: '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
    bold: '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf',
  },
};

/** A font file in memory, under the name the PDF library knows it by. */
export interface LoadedFont {
  readonly family: FontFamily;
  readonly cut: FontCut;
  /** Name in the virtual file system of the PDF library, for example `Manrope-bold.ttf`. */
  readonly name: string;
  readonly data: Buffer;
}

/**
 * The OpenType features that join letters into one glyph: standard, contextual,
 * discretionary and historical ligatures. Required ligatures (`rlig`) are not among
 * them: a script that needs them cannot be written without.
 */
const LIGATURE_FEATURES = ['liga', 'clig', 'dlig', 'hlig'];

/** A feature tag that no font and no layout engine knows. */
const NO_FEATURE = 'zzzz';

/**
 * Returns a copy of a TrueType or OpenType font in which the ligature features are
 * renamed to a tag nobody asks for, so that the layout engine never applies them.
 *
 * Why: Manrope joins "fi", "ff", "fl", "tt" and "--" into one glyph, Noto Sans "fi",
 * "ffi" and more. A PDF then holds one glyph for two letters, and some PDF readers copy
 * and search only the first of them ("digrafima" comes out as "digrafma"). A document
 * about money must read back exactly as it was written, in every reader.
 *
 * Why here and not as a text option: asking the PDF library for "no ligatures" per text
 * makes it lay out every text from scratch, without its cache (measured: a table of 200
 * rows took three to four times as long). With the feature gone from the font, the default and
 * cached path is ligature-free, for every text the library draws: content, list markers,
 * page numbers and watermarks alike.
 *
 * What is changed: four bytes per feature record in the feature list of the GSUB table
 * (OpenType specification, "Feature List Table"). No outline, metric or mapping is
 * touched, and the embedded subset of a PDF never contains this table.
 */
export function withoutLigatures(font: Buffer): Buffer {
  const copy = Buffer.from(font);
  const tableCount = copy.readUInt16BE(4);
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (copy.toString('latin1', record, record + 4) !== 'GSUB') {
      continue;
    }
    const table = copy.readUInt32BE(record + 8);
    const featureList = table + copy.readUInt16BE(table + 6);
    const featureCount = copy.readUInt16BE(featureList);
    for (let feature = 0; feature < featureCount; feature += 1) {
      const tag = featureList + 2 + feature * 6;
      if (LIGATURE_FEATURES.includes(copy.toString('latin1', tag, tag + 4))) {
        copy.write(NO_FEATURE, tag, 'latin1');
      }
    }
  }
  return copy;
}

/** Reads the four font files and switches their ligatures off. Call it once per process. */
export function loadFonts(): LoadedFont[] {
  return FONT_FAMILIES.flatMap((family) =>
    FONT_CUTS.map((cut) => ({
      family,
      cut,
      name: `${family}-${cut}.ttf`,
      data: withoutLigatures(readFileSync(require.resolve(FONT_PACKAGE_FILES[family][cut]))),
    })),
  );
}
