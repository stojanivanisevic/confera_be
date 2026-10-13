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
 * Neither family has an italic cut here, so italics map to the upright files: a layout
 * that asks for italics gets upright text instead of an error.
 */
export const PRIMARY_FONT = 'Manrope';
export const FALLBACK_FONT = 'NotoSans';

/** Order matters: a character goes to the first family that has it. */
export const FONT_FAMILIES = [PRIMARY_FONT, FALLBACK_FONT] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export interface FontFiles {
  readonly normal: string;
  readonly bold: string;
  readonly italics: string;
  readonly bolditalics: string;
}

function family(regular: string, bold: string): FontFiles {
  return { normal: regular, bold, italics: regular, bolditalics: bold };
}

/** Absolute paths of the font files, resolved from the installed packages. */
export function fontFiles(): Readonly<Record<FontFamily, FontFiles>> {
  return {
    Manrope: family(
      require.resolve('@expo-google-fonts/manrope/400Regular/Manrope_400Regular.ttf'),
      require.resolve('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf'),
    ),
    NotoSans: family(
      require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf'),
      require.resolve('@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf'),
    ),
  };
}
