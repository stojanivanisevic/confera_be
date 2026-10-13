// Reads a PDF with pdf.js and prints what is in it as JSON:
//   { pages: [{ lines: string[] }], fonts: [{ name, embedded }] }
// Used by the golden text-extraction test of the PDF module. It runs in its own process
// because pdf.js is an ES module, which Jest's module sandbox cannot load on Node 22.
//
//   node test/support/pdf-extract.mjs <file.pdf>
import { readFileSync } from 'node:fs';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: node test/support/pdf-extract.mjs <file.pdf>\n');
  process.exit(2);
}

const loading = getDocument({
  data: new Uint8Array(readFileSync(file)),
  // Never fall back to a font of this machine: only what is inside the file counts.
  useSystemFonts: false,
  disableFontFace: true,
  fontExtraProperties: true,
  verbosity: 0,
});
const document = await loading.promise;

const pages = [];
const fonts = new Map();

for (let number = 1; number <= document.numPages; number += 1) {
  const page = await document.getPage(number);

  // Text, line by line, in the order of the content stream.
  const content = await page.getTextContent();
  const lines = [];
  let line = '';
  for (const item of content.items) {
    if (!('str' in item)) {
      continue;
    }
    line += item.str;
    if (item.hasEOL) {
      lines.push(line);
      line = '';
    }
  }
  if (line !== '') {
    lines.push(line);
  }
  pages.push({ lines });

  // The fonts the page really draws with, and whether their program is inside the file.
  const operators = await page.getOperatorList();
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    if (operators.fnArray[index] !== OPS.setFont) {
      continue;
    }
    const id = operators.argsArray[index][0];
    const font = page.commonObjs.get(id);
    const name = font.name ?? id;
    fonts.set(name, { name, embedded: font.missingFile === false });
  }
}

process.stdout.write(JSON.stringify({ pages, fonts: [...fonts.values()] }));
await loading.destroy();
