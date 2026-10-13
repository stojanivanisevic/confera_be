import { Injectable } from '@nestjs/common';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { withFonts } from './document-fonts';
import { type FontFiles, fontFiles } from './fonts';
import { GlyphCoverage } from './glyph-coverage';

/** A document definition of pdfmake. Layouts are code and build one of these (ADR-16). */
export type PdfDocument = TDocumentDefinitions;

interface PdfMake {
  setFonts(fonts: Readonly<Record<string, FontFiles>>): void;
  setUrlAccessPolicy(policy: (url: string) => boolean): void;
  setLocalAccessPolicy(policy: (path: string) => boolean): void;
  createPdf(definition: object): { getBuffer(): Promise<Buffer> };
}

interface Engine {
  readonly pdfmake: PdfMake;
  readonly coverage: GlyphCoverage;
}

/**
 * Makes PDF files with pdfmake and embedded fonts (ADR-16).
 *
 * - Every text of a document is checked against the embedded fonts first; a character
 *   that no font has stops the render with MissingGlyphError.
 * - Only the font files of this module can be read from disk, and nothing is ever
 *   fetched from a network address: a document cannot make the server open a file or
 *   call a URL.
 * - The result is the bytes. Storing them once with their checksum, and serving them
 *   from store, is the document module's job.
 */
@Injectable()
export class PdfRenderer {
  private engine: Engine | undefined;

  /** Loaded at the first use: the fonts are large, and most processes never make a PDF. */
  private load(): Engine {
    if (this.engine === undefined) {
      // pdfmake exports one shared instance; this renderer is its only user.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfmake = require('pdfmake') as PdfMake;
      const fonts = fontFiles();
      const allowed = new Set(
        Object.values(fonts).flatMap(({ normal, bold, italics, bolditalics }) => [
          normal,
          bold,
          italics,
          bolditalics,
        ]),
      );
      pdfmake.setFonts(fonts);
      pdfmake.setUrlAccessPolicy(() => false);
      pdfmake.setLocalAccessPolicy((path) => allowed.has(path));
      this.engine = { pdfmake, coverage: new GlyphCoverage() };
    }
    return this.engine;
  }

  /** The glyph check alone, for validating a text before a document is issued. */
  missingCharacters(text: string) {
    return this.load().coverage.missing(text);
  }

  async render(definition: PdfDocument): Promise<Buffer> {
    const { pdfmake, coverage } = this.load();
    const prepared = withFonts(definition, coverage);
    return pdfmake.createPdf(prepared).getBuffer();
  }
}
