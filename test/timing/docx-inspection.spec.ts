import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adversarialRelationships, docxWithRelationships } from '../support/office-files';
import { repoRoot, runNode } from '../support/run-node';

/**
 * SEC-M3-11, the gate: the inspection of a `.docx` reads a relationship part of 1 MB in any of
 * the shapes that make a backtracking pattern quadratic in under 100 ms. A quadratic scan
 * would take seconds to hours, and the API serves nobody meanwhile.
 *
 * Measured as the PDF gate is (pdf-cold-start.spec.ts): in fresh processes of plain Node,
 * which is what a server is, alone in its step, and the middle one of three processes counts
 * (each takes the best of three runs per file): other work on the machine only adds time.
 *
 * `corepack pnpm test:timing` builds `dist-dev/` first.
 */
const LIMIT_MS = 100;
const PROCESSES = 3;
const SCRIPT = join('test', 'support', 'docx-inspection-timing.cjs');
const DETECTION = join(repoRoot, 'dist-dev', 'modules', 'files', 'file-type.js');

describe('the inspection of a .docx from a fresh process (SEC-M3-11)', () => {
  jest.setTimeout(300_000);

  const folder = join(repoRoot, 'tmp', `docx-timing-${randomUUID()}`);
  const files = new Map<string, string>();
  const measured: Record<string, number>[] = [];

  beforeAll(async () => {
    if (!existsSync(DETECTION)) {
      throw new Error(`${DETECTION} is missing: run "corepack pnpm build:dev" first.`);
    }
    mkdirSync(folder, { recursive: true });
    adversarialRelationships().forEach(([name, relationships], index) => {
      const path = join(folder, `${String(index)}.docx`);
      writeFileSync(path, docxWithRelationships(relationships));
      files.set(name, path);
    });
    for (let attempt = 1; attempt <= PROCESSES; attempt += 1) {
      const result = await runNode([SCRIPT, ...files.values()], { timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        throw new Error(`${SCRIPT} ended with exit code ${String(result.exitCode)}:
${result.output}`);
      }
      measured.push(JSON.parse(result.stdout) as Record<string, number>);
    }
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it.each(adversarialRelationships().map(([name]) => [name]))(
    'a 1 MB relationship part of %s is judged in under 100 ms',
    (name) => {
      const path = files.get(name) ?? '';
      const times = measured.map((times) => times[path] ?? Number.POSITIVE_INFINITY);
      const middle = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
      expect({ name, times, under: (middle ?? Number.POSITIVE_INFINITY) < LIMIT_MS }).toEqual({
        name,
        times,
        under: true,
      });
    },
  );
});
