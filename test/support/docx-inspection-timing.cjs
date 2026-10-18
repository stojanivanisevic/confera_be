// Times the type detection of the given files in a fresh Node process, as a process of
// Confera reads an upload, and prints one line of JSON: the best of three runs per file, in
// milliseconds.
//
//   node test/support/docx-inspection-timing.cjs <file>...   (needs `pnpm build:dev`)
//
// Used by test/timing/docx-inspection.spec.ts, the gate of SEC-M3-11. It runs in plain Node
// on purpose: inside Jest the same scan takes five to twenty times as long.
const { join } = require('node:path');

const { detectFileType } = require(
  join(__dirname, '..', '..', 'dist-dev', 'modules', 'files', 'file-type.js'),
);

async function main() {
  const times = {};
  for (const path of process.argv.slice(2)) {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      await detectFileType(path);
      best = Math.min(best, performance.now() - started);
    }
    times[path] = Math.round(best * 10) / 10;
  }
  process.stdout.write(`${JSON.stringify(times)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
