import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';

/**
 * What the scan for secret-like names leaves out in this repository
 * (scripts/secret-scan.config.mjs; README section 12, "What is not read").
 *
 * An exclusion is the cheapest way to make a finding go away, so the list is written out
 * here, with the reason for each entry: a new entry is a decision, in a diff a reviewer
 * sees, and never the answer to a finding in a hand-written file.
 */

const REVIEWED_EXCLUSIONS: Readonly<Record<string, string>> = {
  'openapi/':
    'the OpenAPI documents, generated from the code by `pnpm openapi:generate` and committed',
};

/** Files a person writes. No exclusion may ever cover one of them. */
const HAND_WRITTEN = [
  '.env.example',
  'README.md',
  'docker-compose.yml',
  'package.json',
  'pnpm-workspace.yaml',
  'prisma/schema.prisma',
  'scripts/supply-chain.mjs',
  'scripts/seed-e2e.mjs',
  'src/main.ts',
  'src/config/config.schema.ts',
  'test/e2e/seed/e2e-seed.json',
  'test/tooling/secret-scan-exclusions.spec.ts',
  'deploy/production.env',
  '.github/workflows/ci.yml',
];

describe('what the secret scan leaves out', () => {
  let excluded: string[] = [];
  let listed: string[] = [];

  beforeAll(async () => {
    const program = [
      "import { SECRET_SCAN_EXCLUDE } from './scripts/secret-scan.config.mjs';",
      "import { listFiles } from './scripts/secret-assignments/secret-assignments.mjs';",
      // Every file the scan would take in this repository, before the exclusions.
      'process.stdout.write(JSON.stringify({ exclude: SECRET_SCAN_EXCLUDE, all: listFiles(process.cwd()) }));',
    ].join('\n');
    const run = await runNode(['--input-type=module', '--eval', program]);
    if (run.exitCode !== 0) {
      throw new Error(`could not read the configuration of the scan:\n${run.output}`);
    }
    const answer = JSON.parse(run.stdout) as { exclude: string[]; all: string[] };
    excluded = answer.exclude;
    listed = answer.all.map((file) => file.replaceAll('\\', '/'));
  }, 120_000);

  it('is the reviewed list and nothing more', () => {
    expect([...excluded].sort()).toEqual(Object.keys(REVIEWED_EXCLUSIONS).sort());
  });

  it('every entry is a folder of this repository, written as a folder (no pattern, no single file)', () => {
    for (const entry of excluded) {
      expect(entry).toMatch(/^[a-z0-9][a-z0-9/-]*\/$/);
      expect(existsSync(join(repoRoot, entry))).toBe(true);
    }
  });

  it('no entry covers a file that a person writes', () => {
    const covered = (file: string) => excluded.some((entry) => file.startsWith(entry));
    expect(HAND_WRITTEN.filter(covered)).toEqual([]);
    // Everything that is left out is inside the reviewed folders, among the files the scan would take.
    const leftOut = listed.filter(covered);
    expect(leftOut.length).toBeGreaterThan(0);
    for (const file of leftOut) {
      expect(Object.keys(REVIEWED_EXCLUSIONS).some((entry) => file.startsWith(entry))).toBe(true);
    }
    // And the source tree, the scripts, the tests and the deploy files are all read.
    for (const folder of ['src/', 'scripts/', 'test/', 'prisma/']) {
      const inFolder = listed.filter((file) => file.startsWith(folder));
      expect(inFolder.length).toBeGreaterThan(0);
      expect(inFolder.filter(covered)).toEqual([]);
    }
  });

  it('the supply-chain check scans with exactly this list', () => {
    const text = readFileSync(join(repoRoot, 'scripts', 'supply-chain.mjs'), 'utf8');
    expect(text).toContain("import { SECRET_SCAN_EXCLUDE } from './secret-scan.config.mjs';");
    expect(text.match(/scanDirectory\(/g)).toHaveLength(1);
    expect(text).toContain('scanDirectory(repoRoot, { exclude: SECRET_SCAN_EXCLUDE })');
  });

  it('the README names every folder that is left out', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    for (const entry of excluded) {
      expect(readme).toContain(`\`${entry}\``);
    }
  });
});
