import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';

/**
 * Edge case found by the edge-case hunter (M1-REV-01): a very large input to the PDF
 * renderer, of the one shape that the renderer does not survive.
 *
 * NFR-PERF-03 and M1-BE-05: a PDF is made in under 5 seconds. A long text with spaces is
 * fine (100 000 characters: about 2 s), so are many rows (5 000 rows: about 2.5 s). A long
 * WORD, a text without a space, in a column narrower than the word, is not: pdfmake breaks
 * it character by character, and the time grows with about the square of its length. On
 * the development laptop, in plain Node: 1 000 characters in a column of 20 pt 2.8 s,
 * 2 000 characters 10 s, 5 000 characters of a Serbian name 158 s.
 *
 * The render is synchronous work on the event loop of the API (or later of the worker),
 * so for that whole time the process answers nothing else. The text of an author, a payer
 * or an institution reaches the documents of 0.6.0 and later; "every printed field has a
 * length limit" (ADR-16) is a rule for the layouts, which do not exist yet, while the
 * renderer is delivered now and is what every layout will call. Whatever the fix (a limit
 * on the length of a word, breaking it before pdfmake does, a time budget, another
 * thread), the render must END in under 5 seconds: with the bytes, or refused with an
 * error that says why.
 *
 * Measured like the gate of this tier (pdf-cold-start.spec.ts): in a fresh process of
 * plain Node, with nothing else running.
 */

const LIMIT_MS = 5000;
const RENDERER = join(repoRoot, 'dist-dev', 'platform', 'pdf', 'pdf-renderer.js');

/** Runs in the fresh process. The word is "Šćepanović" 300 times: 3 000 characters, no space. */
const PROBE = `
const { join } = require('node:path');
require('@nestjs/common');
const { PdfRenderer } = require(join(process.cwd(), 'dist-dev', 'platform', 'pdf', 'pdf-renderer.js'));
const renderer = new PdfRenderer();
renderer.warmUp();
const word = '\\u0160\\u0107epanovi\\u0107'.repeat(300);
const started = performance.now();
renderer
  .render({ content: [{ table: { widths: [20, '*'], body: [[word, 'x']] } }] })
  .then(
    (bytes) => ({ outcome: 'made', bytes: bytes.length }),
    (error) => ({ outcome: 'refused', error: error instanceof Error ? error.name : String(error) }),
  )
  .then((result) => {
    process.stdout.write(JSON.stringify({ ...result, ms: Math.round(performance.now() - started) }) + '\\n');
  });
`;

describe('edge case (M1-REV-01): one long word in a narrow column of a PDF (NFR-PERF-03)', () => {
  jest.setTimeout(180_000);

  it('the render ends in under 5 seconds, made or refused', async () => {
    if (!existsSync(RENDERER)) {
      throw new Error(`${RENDERER} is missing: run "corepack pnpm build:dev" first.`);
    }
    const result = await runNode(['-e', PROBE], { timeoutMs: 120_000 });
    const measured = result.timedOut
      ? { outcome: 'still rendering after 120 s', ms: 120_000 }
      : (JSON.parse(result.stdout) as { outcome: string; ms: number });
    process.stdout.write(
      `one word of 3 000 characters in a column of 20 pt: ${JSON.stringify(measured)}\n`,
    );
    expect({ endedInTime: measured.ms < LIMIT_MS, measured }).toEqual({
      endedInTime: true,
      measured: expect.objectContaining({ outcome: expect.stringMatching(/^(made|refused)$/) }),
    });
  });
});
