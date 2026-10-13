import { Module } from '@nestjs/common';
import { PdfRenderer } from './pdf-renderer';

/** PDF generation (ADR-16). Layouts of documents arrive with the document module. */
@Module({ providers: [PdfRenderer], exports: [PdfRenderer] })
export class PdfModule {}
