import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEVELOPMENT_ENTRY, PRODUCTION_ENTRY } from '../support/api-process';
import { repoRoot } from '../support/run-node';

/**
 * ST-02, for the test tools (ADR-24: "the dev-tools module (dev login, API docs, stubs,
 * seeds) is left out of the production image"): the seed of the end-to-end tests, its
 * invented people and the stub slot are in no build. They are plain scripts outside
 * src/, started by `pnpm seed:e2e` and `pnpm stubs`; nothing that ships can run them.
 */

const BUILDS = { production: join(repoRoot, 'dist'), development: join(repoRoot, 'dist-dev') };

interface Seed {
  readonly organisations: readonly {
    readonly id: string;
    readonly name: string;
    readonly users: readonly { readonly id: string; readonly email: string }[];
  }[];
}

const seed = JSON.parse(
  readFileSync(join(repoRoot, 'test', 'e2e', 'seed', 'e2e-seed.json'), 'utf8'),
) as Seed;

const FORBIDDEN_TEXT = [
  'seed-e2e',
  'seed:e2e',
  'e2e-seed',
  'no_stub',
  'the stub slot',
  'STUBS_PORT',
  ...seed.organisations.flatMap((organisation) => [
    organisation.id,
    organisation.name,
    ...organisation.users.flatMap((user) => [user.id, user.email]),
  ]),
];

const FORBIDDEN_PATH = /seed|stubs?\b|e2e|factor(y|ies)/i;

function filesOf(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesOf(path) : [path];
  });
}

function findings(build: string): string[] {
  const found: string[] = [];
  for (const file of filesOf(build)) {
    const name = relative(build, file).replaceAll('\\', '/');
    if (FORBIDDEN_PATH.test(name)) {
      found.push(`${name}: the path`);
    }
    const content = readFileSync(file, 'utf8');
    for (const text of FORBIDDEN_TEXT) {
      if (content.includes(text)) {
        found.push(`${name}: "${text}"`);
      }
    }
  }
  return found;
}

describe('the test tools are in no build (ST-02)', () => {
  jest.setTimeout(60_000);

  beforeAll(() => {
    for (const entry of [PRODUCTION_ENTRY, DEVELOPMENT_ENTRY]) {
      if (!existsSync(join(repoRoot, entry))) {
        throw new Error(`${entry} is missing: run "corepack pnpm build" and "build:dev" first`);
      }
    }
  });

  it('knows what to look for', () => {
    expect(seed.organisations.length).toBeGreaterThan(0);
    expect(FORBIDDEN_TEXT.length).toBeGreaterThan(10);
  });

  it('the search can see: the scripts themselves hold these texts', () => {
    const scripts = ['seed-e2e.mjs', 'stubs.mjs']
      .map((name) => readFileSync(join(repoRoot, 'scripts', name), 'utf8'))
      .join('\n');
    for (const text of ['seed:e2e', 'e2e-seed', 'no_stub', 'the stub slot', 'STUBS_PORT']) {
      expect(scripts).toContain(text);
    }
  });

  it.each(Object.entries(BUILDS))(
    'the %s build holds no seed, no seeded person and no stub',
    (_name, build) => {
      expect(findings(build)).toEqual([]);
    },
  );

  it('no file of src/ starts or imports a test tool', () => {
    const offenders = filesOf(join(repoRoot, 'src'))
      .filter((file) => file.endsWith('.ts') && !file.includes(join('src', 'generated')))
      .filter((file) => /seed-e2e|scripts\/stubs|test\/e2e/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file).replaceAll('\\', '/'));
    expect(offenders).toEqual([]);
  });
});
