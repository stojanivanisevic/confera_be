// Measures the first document of a fresh Node process, as a process of Confera makes it,
// and prints one line of JSON with the times in milliseconds.
//
//   node test/support/pdf-cold-start.cjs        (needs `pnpm build:dev`)
//
// Used by test/timing/pdf-cold-start.spec.ts, the gate of NFR-PERF-03.
// It runs in plain Node on purpose: that is what a server is. Inside Jest the PDF library
// runs in Jest's sandbox, at the same time as the other test files, and a render takes
// two to ten times as long.
const { join } = require('node:path');

const build = join(__dirname, '..', '..', 'dist-dev', 'platform', 'pdf');
const ms = (since) => Math.round(performance.now() - since);

async function main() {
  // The framework is loaded before a process serves anything, so no document waits for
  // it. It is loaded first and timed apart.
  let mark = performance.now();
  require('@nestjs/common');
  const frameworkMs = ms(mark);

  // Everything the first document of a process waits for: the modules of the renderer,
  // the PDF library, the fonts, and the render itself.
  const coldStarted = performance.now();
  const { PdfRenderer } = require(join(build, 'pdf-renderer.js'));
  const { BILINGUAL_SAMPLE } = require(join(build, '__fixtures__', 'bilingual-sample.js'));
  const renderer = new PdfRenderer();
  mark = performance.now();
  renderer.warmUp();
  const warmUpMs = ms(mark);
  const sample = await renderer.render(BILINGUAL_SAMPLE);
  const firstDocumentMs = ms(coldStarted);

  const nextMs = [];
  for (let index = 0; index < 5; index += 1) {
    mark = performance.now();
    await renderer.render(BILINGUAL_SAMPLE);
    nextMs.push(ms(mark));
  }

  const rows = Array.from({ length: 200 }, (_unused, index) => [
    `Stavka ${index + 1}: šđčćž ŠĐČĆŽ`,
    `Item ${index + 1}`,
    `${index + 1},00 RSD`,
  ]);
  mark = performance.now();
  const table = await renderer.render({
    content: [
      {
        table: {
          headerRows: 1,
          widths: ['*', 100, 80],
          body: [['Opis', 'Description', 'Iznos'], ...rows],
        },
      },
    ],
  });
  const rows200Ms = ms(mark);

  process.stdout.write(
    `${JSON.stringify({
      frameworkMs,
      warmUpMs,
      firstDocumentMs,
      nextMs,
      rows200Ms,
      sampleBytes: sample.length,
      sampleStart: sample.subarray(0, 5).toString('latin1'),
      tableBytes: table.length,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
