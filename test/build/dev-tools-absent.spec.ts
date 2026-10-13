import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  validEnvironment,
  validProductionEnvironment,
} from '../../src/config/testing/valid-environment';
import { DEV_TOOLS_ROUTES } from '../../src/modules/dev-tools/dev-tools.routes';
import {
  DEVELOPMENT_ENTRY,
  PRODUCTION_ENTRY,
  type RunningApi,
  startApi,
} from '../support/api-process';
import { repoRoot } from '../support/run-node';

/**
 * ST-02 (NFR-SEC-04): dev tools are absent from the production build, not switched off.
 *
 * - no path of dist/ belongs to the dev-tools module;
 * - no file of dist/ contains a dev-tools route or a name of that module;
 * - the running production build answers 404 on every dev-tools route.
 *
 * The same search over dist-dev/ must find them, which proves that the search can see.
 */

const PRODUCTION_BUILD = join(repoRoot, 'dist');
const DEVELOPMENT_BUILD = join(repoRoot, 'dist-dev');

const FORBIDDEN_PATH = /dev-tools|main\.dev/;

const FORBIDDEN_TEXT = [
  ...Object.values(DEV_TOOLS_ROUTES),
  'dev-tools',
  'DevTools',
  'DevInfo',
  // The interactive API documentation and the code that builds it belong to dev tools.
  'SwaggerModule',
  'swagger-ui',
];

function filesOf(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesOf(path) : [path];
  });
}

function findings(build: string): { paths: string[]; texts: string[] } {
  const paths: string[] = [];
  const texts: string[] = [];
  for (const file of filesOf(build)) {
    const name = relative(build, file).replaceAll('\\', '/');
    if (FORBIDDEN_PATH.test(name)) {
      paths.push(name);
    }
    const content = readFileSync(file, 'utf8');
    for (const text of FORBIDDEN_TEXT) {
      if (content.includes(text)) {
        texts.push(`${name}: "${text}"`);
      }
    }
  }
  return { paths, texts };
}

describe('dev tools are absent from the production build (ST-02)', () => {
  jest.setTimeout(60_000);

  beforeAll(() => {
    for (const entry of [PRODUCTION_ENTRY, DEVELOPMENT_ENTRY]) {
      if (!existsSync(join(repoRoot, entry))) {
        throw new Error(`${entry} is missing: run "corepack pnpm build" and "build:dev" first`);
      }
    }
  });

  it('knows the routes of the dev-tools module', () => {
    expect(Object.values(DEV_TOOLS_ROUTES).length).toBeGreaterThan(0);
    for (const route of Object.values(DEV_TOOLS_ROUTES)) {
      expect(route).toMatch(/^dev\//);
    }
  });

  it('the production build has no dev-tools path', () => {
    expect(findings(PRODUCTION_BUILD).paths).toEqual([]);
  });

  it('the production build has no dev-tools route or name in any file', () => {
    expect(findings(PRODUCTION_BUILD).texts).toEqual([]);
  });

  it('the same search finds them in the development build', () => {
    const found = findings(DEVELOPMENT_BUILD);
    expect(found.paths).toEqual(expect.arrayContaining(['modules/dev-tools/main.dev.js']));
    for (const route of Object.values(DEV_TOOLS_ROUTES)) {
      expect(found.texts.some((text) => text.endsWith(`"${route}"`))).toBe(true);
    }
  });

  describe('at run time', () => {
    let production: RunningApi;
    let development: RunningApi;

    beforeAll(async () => {
      [production, development] = await Promise.all([
        startApi(PRODUCTION_ENTRY, validProductionEnvironment()),
        startApi(DEVELOPMENT_ENTRY, validEnvironment({ STAGE: 'local' })),
      ]);
    });

    afterAll(async () => {
      await Promise.all([production.stop(), development.stop()]);
    });

    it.each(Object.values(DEV_TOOLS_ROUTES))(
      'the production build answers 404 on /%s',
      async (route) => {
        expect((await production.request(`/${route}`)).status).toBe(404);
      },
    );

    it('the development build serves its dev-tools route, which proves the routes are real', async () => {
      const response = await development.request(`/${DEV_TOOLS_ROUTES.info}`);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual({
        stage: 'local',
        devTools: { apiDocs: false, logQueries: false },
      });
    });

    it('both builds answer on /health', async () => {
      for (const api of [production, development]) {
        const response = await api.request('/health');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.text)).toEqual({ status: 'ok' });
      }
    });
  });
});
