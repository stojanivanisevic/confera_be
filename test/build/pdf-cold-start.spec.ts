import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';

/**
 * NFR-PERF-03 on the BUILT application: a PDF is made in under 5 seconds, the first one
 * of a process included (defect D4 of the 0.1.0 verification).
 *
 * The measurement runs in a fresh Node process, test/support/pdf-cold-start.cjs, and not
 * inside Jest. A process of Confera is a plain Node process; inside Jest every module
 * runs in Jest's sandbox, at the same time as the other test files, where the same
 * render takes about twice as long and the first one starts from modules that Jest has
 * already read. The same criterion is also asserted inside Jest by
 * src/platform/pdf/pdf-renderer.spec.ts.
 *
 * Needs `pnpm build:dev`; `pnpm check` runs it first.
 */

const LIMIT_MS = 5000;
const SCRIPT = join('test', 'support', 'pdf-cold-start.cjs');
const RENDERER = join(repoRoot, 'dist-dev', 'platform', 'pdf', 'pdf-renderer.js');

interface Measurement {
  /** Loading the framework, which a process does before it serves anything. */
  readonly frameworkMs: number;
  /** Loading the PDF library and the fonts; part of firstDocumentMs. */
  readonly warmUpMs: number;
  /** From loading the renderer to the bytes of the first document. */
  readonly firstDocumentMs: number;
  readonly nextMs: readonly number[];
  readonly rows200Ms: number;
  readonly sampleBytes: number;
  readonly sampleStart: string;
  readonly tableBytes: number;
}

describe('a PDF from a fresh process (NFR-PERF-03)', () => {
  jest.setTimeout(120_000);

  let measured: Measurement;

  beforeAll(async () => {
    if (!existsSync(RENDERER)) {
      throw new Error(`${RENDERER} is missing: run "corepack pnpm build:dev" first.`);
    }
    const result = await runNode([SCRIPT], { timeoutMs: 100_000 });
    if (result.exitCode !== 0) {
      throw new Error(`${SCRIPT} ended with exit code ${String(result.exitCode)}:
${result.output}`);
    }
    measured = JSON.parse(result.stdout) as Measurement;
    // Kept in the test output as the numbers of the gate.
    process.stdout.write(
      `PDF cold start in plain Node: first document ${String(measured.firstDocumentMs)} ms ` +
        `(of which library and fonts ${String(measured.warmUpMs)} ms), then ${measured.nextMs.join(', ')} ms; ` +
        `200 rows ${String(measured.rows200Ms)} ms; framework before that ${String(measured.frameworkMs)} ms\n`,
    );
  });

  it('the documents were really made', () => {
    expect(measured.sampleStart).toBe('%PDF-');
    expect(measured.sampleBytes).toBeGreaterThan(10_000);
    expect(measured.tableBytes).toBeGreaterThan(10_000);
    expect(measured.nextMs).toHaveLength(5);
  });

  it('the first document of a process, with the PDF library and the fonts still to load, takes under 5 seconds', () => {
    expect(measured.firstDocumentMs).toBeLessThan(LIMIT_MS);
    // The loading is inside that time, not beside it.
    expect(measured.warmUpMs).toBeGreaterThan(0);
    expect(measured.warmUpMs).toBeLessThanOrEqual(measured.firstDocumentMs);
  });

  it('every document after it takes under 5 seconds', () => {
    expect(Math.max(...measured.nextMs)).toBeLessThan(LIMIT_MS);
  });

  it('a table of 200 rows takes under 5 seconds', () => {
    expect(measured.rows200Ms).toBeLessThan(LIMIT_MS);
  });
});
