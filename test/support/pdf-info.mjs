// Reads the document information of a PDF (title, author, subject, keywords) with pdf.js
// and prints it as JSON. Used by test/qa/pdf-fields.spec.ts. It runs in its own process
// because pdf.js is an ES module, which Jest's module sandbox cannot load on Node 22.
//
//   node test/support/pdf-info.mjs <file.pdf>
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: node test/support/pdf-info.mjs <file.pdf>\n');
  process.exit(2);
}

const loading = getDocument({
  data: new Uint8Array(readFileSync(file)),
  useSystemFonts: false,
  disableFontFace: true,
  verbosity: 0,
});
const document = await loading.promise;
const { info } = await document.getMetadata();
process.stdout.write(
  JSON.stringify({
    title: info.Title ?? null,
    author: info.Author ?? null,
    subject: info.Subject ?? null,
    keywords: info.Keywords ?? null,
  }),
);
await loading.destroy();
