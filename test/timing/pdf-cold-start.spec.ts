import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';

/**
 * NFR-PERF-03, the gate: a PDF is made in under 5 seconds, the first one of a process
 * included (defect D4 of the 0.1.0 verification).
 *
 * Time is measured where it means something, and so that the result does not depend on
 * what else the machine is doing:
 *
 * - in a fresh process of plain Node (test/support/pdf-cold-start.cjs), which is what a
 *   server is. Inside Jest the PDF library runs in Jest's sandbox: on the development
 *   laptop a table of 200 rows takes 0.1 s in plain Node, 0.25 s in a Jest file that
 *   runs alone, and 0.5 to 3 s when the whole unit tier runs on all processors;
 * - alone: this tier is a step of its own in `pnpm check`, with no other test beside it;
 * - three times, each in a new process, and the fastest counts. Other work on the
 *   machine can only add time to a measurement, never take any away, so the fastest of
 *   three is the closest to what the code itself costs. Every one of the three is a cold
 *   start.
 *
 * `corepack pnpm test:timing` builds `dist-dev/` first.
 */

const LIMIT_MS = 5000;
const ATTEMPTS = 3;
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
  jest.setTimeout(300_000);

  const measured: Measurement[] = [];

  /** The fastest of the processes, by one of the measured times. */
  function fastest(time: (measurement: Measurement) => number): number {
    return Math.min(...measured.map(time));
  }

  beforeAll(async () => {
    if (!existsSync(RENDERER)) {
      throw new Error(`${RENDERER} is missing: run "corepack pnpm build:dev" first.`);
    }
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const result = await runNode([SCRIPT], { timeoutMs: 90_000 });
      if (result.exitCode !== 0) {
        throw new Error(`${SCRIPT} ended with exit code ${String(result.exitCode)}:
${result.output}`);
      }
      const measurement = JSON.parse(result.stdout) as Measurement;
      measured.push(measurement);
      // Kept in the test output as the numbers of the gate.
      process.stdout.write(
        `PDF in a fresh process ${String(attempt)}/${String(ATTEMPTS)}: first document ${String(measurement.firstDocumentMs)} ms ` +
          `(of which library and fonts ${String(measurement.warmUpMs)} ms), then ${measurement.nextMs.join(', ')} ms; ` +
          `200 rows ${String(measurement.rows200Ms)} ms; framework before that ${String(measurement.frameworkMs)} ms\n`,
      );
    }
  });

  it('the documents were really made, in every process', () => {
    expect(measured).toHaveLength(ATTEMPTS);
    for (const measurement of measured) {
      expect(measurement.sampleStart).toBe('%PDF-');
      expect(measurement.sampleBytes).toBeGreaterThan(10_000);
      expect(measurement.tableBytes).toBeGreaterThan(10_000);
      expect(measurement.nextMs).toHaveLength(5);
    }
  });

  it('the loading of the PDF library and the fonts is inside the time of the first document', () => {
    for (const measurement of measured) {
      expect(measurement.warmUpMs).toBeGreaterThan(0);
      expect(measurement.warmUpMs).toBeLessThanOrEqual(measurement.firstDocumentMs);
    }
  });

  it('the first document of a process takes under 5 seconds', () => {
    expect(fastest((measurement) => measurement.firstDocumentMs)).toBeLessThan(LIMIT_MS);
  });

  it('every document after it takes under 5 seconds', () => {
    expect(fastest((measurement) => Math.max(...measurement.nextMs))).toBeLessThan(LIMIT_MS);
  });

  it('a table of 200 rows takes under 5 seconds', () => {
    expect(fastest((measurement) => measurement.rows200Ms)).toBeLessThan(LIMIT_MS);
  });
});
