import { SECRET_VARIABLE_NAMES } from '../../src/config/config.schema';
import { validProductionEnvironment } from '../../src/config/testing/valid-environment';
import { PRODUCTION_ENTRY, type RunningApi, startApi } from '../support/api-process';

/**
 * A clean production start of the built application (NFR-SEC-04, ADR-24):
 *
 * - ST-03: with a canary in every secret variable, no canary in the output;
 * - ST-65: no response of any route, a preflight included, carries a CORS grant;
 * - ST-65: a stored file asked for by its storage key under any prefix is not found.
 */

const CANARY = 'canary-5b7e21f0c9';

function productionEnvironment(): Record<string, string | undefined> {
  const env = validProductionEnvironment();
  for (const name of SECRET_VARIABLE_NAMES) {
    const url = new URL(env[name] ?? '');
    url.password = `${CANARY}-${name.toLowerCase()}`;
    env[name] = url.toString();
  }
  return env;
}

const ADMIN_HOST = 'admin.confera.test';
const PUBLIC_HOST = 'forms.confera.test';

const PATHS = ['/health', '/', '/api/v1/meta', '/public/v1/forms/abc', '/no/such/route'];
const METHODS = ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
const ORIGINS = [
  `https://${ADMIN_HOST}`,
  `https://${PUBLIC_HOST}`,
  'https://conference-site.example',
  'null',
];

/** A storage key as ADR-10 shapes it: organisation and a random id, never a file name. */
const STORAGE_KEY = 'org/5a1f0c7e-3b2d-4e6f-8a9b-0c1d2e3f4a5b/9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';

const STATIC_PREFIXES = [
  '',
  '/uploads',
  '/upload',
  '/files',
  '/file',
  '/static',
  '/public',
  '/storage',
  '/assets',
  '/media',
  '/data',
  '/api/v1/files',
  '/public/v1/files',
];

describe('a clean production start', () => {
  jest.setTimeout(120_000);

  let api: RunningApi;

  beforeAll(async () => {
    api = await startApi(PRODUCTION_ENTRY, productionEnvironment());
  });

  afterAll(async () => {
    await api.stop();
  });

  it('has a canary in every secret variable of the schema', () => {
    expect(SECRET_VARIABLE_NAMES.length).toBeGreaterThan(0);
    const env = productionEnvironment();
    for (const name of SECRET_VARIABLE_NAMES) {
      expect(env[name]).toContain(CANARY);
    }
  });

  describe('no response carries a CORS grant (ST-65)', () => {
    const cases = PATHS.flatMap((path) =>
      METHODS.flatMap((method) => ORIGINS.map((origin) => [method, path, origin] as const)),
    );

    it.each(cases)('%s %s from %s', async (method, path, origin) => {
      const response = await api.request(path, {
        method,
        headers: {
          host: path.startsWith('/public') ? PUBLIC_HOST : ADMIN_HOST,
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, x-csrf-token, x-form-token',
        },
      });
      const grants = Object.keys(response.headers).filter((name) =>
        name.toLowerCase().startsWith('access-control-'),
      );
      expect(grants).toEqual([]);
      // A preflight gets no "yes" in any form.
      if (method === 'OPTIONS') {
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('no route serves a stored file by its storage key (ST-65)', () => {
    it.each(STATIC_PREFIXES)('GET %s/<storage key> is not found', async (prefix) => {
      for (const host of [ADMIN_HOST, PUBLIC_HOST]) {
        const response = await api.request(`${prefix}/${STORAGE_KEY}`, { headers: { host } });
        expect(response.status).toBe(404);
      }
    });

    it.each(['/../package.json', '/..%2f..%2fpackage.json', '/.env', '/dist/main.js'])(
      'GET %s is not found',
      async (path) => {
        expect((await api.request(path, { headers: { host: ADMIN_HOST } })).status).toBe(404);
      },
    );
  });

  describe('the two surfaces (ST-66, routing part)', () => {
    it('GET /api/v1/meta answers under the admin host name', async () => {
      const response = await api.request('/api/v1/meta', { headers: { host: ADMIN_HOST } });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual({
        name: 'confera-api',
        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      });
    });

    it.each([PUBLIC_HOST, 'evil.example', '127.0.0.1'])(
      'GET /api/v1/meta under %s is not found',
      async (host) => {
        const response = await api.request('/api/v1/meta', { headers: { host } });
        expect(response.status).toBe(404);
        expect(JSON.parse(response.text)).toEqual(
          expect.objectContaining({ code: 'not_found', status: 404 }),
        );
      },
    );
  });

  it('writes its log as JSON lines and nothing else', () => {
    const lines = api
      .output()
      .split(/\r?\n/)
      .filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(api.output()).toContain('api.started');
  });

  it('shows no canary in the output or the logs (ST-03)', async () => {
    // Requests that fail and requests that succeed, so that every kind of log line exists.
    await api.request('/health');
    await api.request('/no/such/route', { headers: { cookie: `session=${CANARY}-cookie` } });
    await api.request('/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CANARY}-bearer` },
      body: JSON.stringify({ password: `${CANARY}-body` }),
    });
    const output = await api.stop();
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(CANARY);
  });
});
