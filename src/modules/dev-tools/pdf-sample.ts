// Writes the bilingual sample PDF of the pdfmake spike (M1-BE-05) to tmp/, to look at:
//
//   corepack pnpm pdf:sample
//
// The same document is what the golden test of the PDF module renders and reads back.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BILINGUAL_SAMPLE } from '../../platform/pdf/__fixtures__/bilingual-sample';
import { PdfRenderer } from '../../platform/pdf/pdf-renderer';

async function main(): Promise<void> {
  const directory = resolve('tmp');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'confera-pdf-sample.pdf');

  const started = performance.now();
  const pdf = await new PdfRenderer().render(BILINGUAL_SAMPLE);
  const elapsed = performance.now() - started;

  writeFileSync(file, pdf);
  process.stdout.write(
    `wrote ${file} (${String(pdf.length)} bytes, rendered in ${elapsed.toFixed(0)} ms)\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'the sample could not be made'}\n`,
  );
  process.exitCode = 1;
});
