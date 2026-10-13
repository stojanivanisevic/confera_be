import { Injectable } from '@nestjs/common';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { withFonts } from './document-fonts';
import { FONT_FAMILIES, type FontFamily, type LoadedFont, loadFonts } from './fonts';
import { GlyphCoverage, type MissingCharacter } from './glyph-coverage';

/** A document definition of pdfmake. Layouts are code and build one of these (ADR-16). */
export type PdfDocument = TDocumentDefinitions;

type FontFiles = Readonly<Record<'normal' | 'bold' | 'italics' | 'bolditalics', string>>;

interface PdfMake {
  readonly virtualfs: { writeFileSync(name: string, content: Buffer): void };
  setFonts(fonts: Readonly<Record<string, FontFiles>>): void;
  setUrlAccessPolicy(policy: (url: string) => boolean): void;
  setLocalAccessPolicy(policy: (path: string) => boolean): void;
  createPdf(definition: object): { getBuffer(): Promise<Buffer> };
}

interface Engine {
  readonly pdfmake: PdfMake;
  readonly coverage: GlyphCoverage;
}

function fontTable(fonts: readonly LoadedFont[]): Record<FontFamily, FontFiles> {
  const name = (family: FontFamily, cut: 'normal' | 'bold'): string => {
    const font = fonts.find((loaded) => loaded.family === family && loaded.cut === cut);
    if (font === undefined) {
      throw new Error(`The font ${family} ${cut} was not loaded.`);
    }
    return font.name;
  };
  const table = {} as Record<FontFamily, FontFiles>;
  for (const family of FONT_FAMILIES) {
    const normal = name(family, 'normal');
    const bold = name(family, 'bold');
    // No italic cuts are embedded: italics are drawn upright.
    table[family] = { normal, bold, italics: normal, bolditalics: bold };
  }
  return table;
}

/**
 * Makes PDF files with pdfmake and embedded fonts (ADR-16).
 *
 * - Every text of a document is checked against the embedded fonts first; a character
 *   that no font has stops the render with MissingGlyphError, and a feature whose text
 *   cannot be checked is refused (see document-fonts.ts).
 * - A document cannot make the server read a file or call an address: the fonts are
 *   handed to pdfmake from memory, and every local path and every URL is refused.
 * - The result is the bytes. Storing them once with their checksum, and serving them
 *   from store, is the document module's job.
 *
 * The PDF library and the fonts are loaded at the first use, once per process. A process
 * that will make documents calls `warmUp()` when it starts, so that no document waits
 * for that.
 */
@Injectable()
export class PdfRenderer {
  private engine: Engine | undefined;

  private load(): Engine {
    if (this.engine === undefined) {
      // pdfmake exports one shared instance; this renderer is its only user.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfmake = require('pdfmake') as PdfMake;
      const fonts = loadFonts();
      for (const font of fonts) {
        pdfmake.virtualfs.writeFileSync(font.name, font.data);
      }
      pdfmake.setFonts(fontTable(fonts));
      pdfmake.setUrlAccessPolicy(() => false);
      pdfmake.setLocalAccessPolicy(() => false);
      this.engine = { pdfmake, coverage: new GlyphCoverage(fonts) };
    }
    return this.engine;
  }

  /**
   * Loads the PDF library and the fonts now instead of at the first document. Safe to
   * call more than once.
   */
  warmUp(): void {
    this.load();
  }

  /** The glyph check alone, for validating a text before a document is issued. */
  missingCharacters(text: string): MissingCharacter[] {
    return this.load().coverage.missing(text);
  }

  async render(definition: PdfDocument): Promise<Buffer> {
    const { pdfmake, coverage } = this.load();
    const prepared = withFonts(definition, coverage);
    return pdfmake.createPdf(prepared).getBuffer();
  }
}
