import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
import { repoRoot, runNode } from '../support/run-node';
import { connectAsSuperuser, seedTwoOrganisations, testDatabase } from './support/database';

/**
 * ST-02 at run time: the production build answers 404 on every dev-tools route, and the
 * development build serves them, which proves that the routes are real.
 * Also: the development convenience DEV_LOG_QUERIES logs statements without values.
 */
describe('dev tools at run time', () => {
  jest.setTimeout(180_000);

  let production: RunningApi;
  let development: RunningApi;

  const database = () => ({
    DATABASE_URL: testDatabase.applicationUrl,
    SYSTEM_DATABASE_URL: testDatabase.systemUrl,
  });

  beforeAll(async () => {
    if (!existsSync(join(repoRoot, DEVELOPMENT_ENTRY))) {
      const built = await runNode([join('scripts', 'build.mjs'), 'tsconfig.build.dev.json'], {
        timeoutMs: 120_000,
      });
      if (built.exitCode !== 0) {
        throw new Error(`the development build failed:\n${built.output}`);
      }
    }
    const superuser = await connectAsSuperuser();
    await seedTwoOrganisations(superuser);
    await superuser.end();

    [production, development] = await Promise.all([
      startApi(PRODUCTION_ENTRY, { ...validProductionEnvironment(), ...database() }),
      startApi(DEVELOPMENT_ENTRY, {
        ...validEnvironment({ STAGE: 'local' }),
        ...database(),
        DEV_API_DOCS: 'true',
        DEV_LOG_QUERIES: 'true',
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([production.stop(), development.stop()]);
  });

  it.each([...Object.values(DEV_TOOLS_ROUTES), 'dev/docs/public', 'dev/docs-json', 'dev', 'docs'])(
    'the production build answers 404 on /%s',
    async (route) => {
      expect((await production.request(`/${route}`)).status).toBe(404);
    },
  );

  it('the development build says which conveniences are on', async () => {
    const response = await development.request(`/${DEV_TOOLS_ROUTES.info}`);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      stage: 'local',
      devTools: { apiDocs: true, logQueries: true },
    });
  });

  it('the development build serves the interactive API documentation', async () => {
    const page = await development.request(`/${DEV_TOOLS_ROUTES.apiDocs}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    const publicPage = await development.request(`/${DEV_TOOLS_ROUTES.apiDocs}/public`);
    expect(publicPage.status).toBe(200);
    const json = await development.request(`/${DEV_TOOLS_ROUTES.apiDocs}-json`);
    expect(JSON.parse(json.text)).toEqual(
      expect.objectContaining({ info: expect.objectContaining({ title: 'Confera admin API' }) }),
    );
  });

  it('DEV_LOG_QUERIES logs each statement, with placeholders instead of values', async () => {
    expect((await development.request('/health/ready')).status).toBe(200);
    const queries = development
      .output()
      .split(/\r?\n/)
      .filter((line) => line.includes('"db.query"'))
      .map((line) => JSON.parse(line) as { query: string; durationMs: number });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((entry) => entry.query.includes('pg_roles'))).toBe(true);
    for (const entry of queries) {
      expect(typeof entry.query).toBe('string');
      expect(typeof entry.durationMs).toBe('number');
      expect(Object.keys(entry)).not.toEqual(expect.arrayContaining(['params']));
    }
  });

  it('the production build logs no statement', async () => {
    expect((await production.request('/health/ready')).status).toBe(200);
    expect(production.output()).not.toContain('db.query');
  });

  it('both builds answer on /health', async () => {
    for (const api of [production, development]) {
      const response = await api.request('/health');
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual({ status: 'ok' });
    }
  });
});
