import type { Client } from 'pg';
import { SECRET_VARIABLE_NAMES } from '../../src/config/config.schema';
import { validProductionEnvironment } from '../../src/config/testing/valid-environment';
import { PRODUCTION_ENTRY, type RunningApi, startApi } from '../support/api-process';
import {
  addressFor,
  connect,
  connectAsSuperuser,
  errorCode,
  rows,
  seedTwoOrganisations,
  SQLSTATE,
  testDatabase,
} from './support/database';

/**
 * A clean production start of the BUILT application against a real database
 * (NFR-SEC-04, NFR-OPS-02, ADR-24):
 *
 * - ST-03: with a canary in every secret variable, no canary in the output or the logs;
 * - ST-65: the application role cannot create or alter a table;
 * - ST-65: no response of any route, a preflight included, carries a CORS grant;
 * - ST-65: a stored file asked for by its storage key under any prefix is not found;
 * - ST-66 (routing part): /api/v1/meta is not found under the public host name.
 *
 * The canaries are the real passwords of two roles made for this run: members of the
 * application and system roles, so they hold exactly their rights.
 */

const CANARY = `canary-${Math.random().toString(16).slice(2, 14)}`;
const CANARY_ROLES = {
  DATABASE_URL: { role: 'confera_canary_app', memberOf: 'confera_app', attributes: '' },
  SYSTEM_DATABASE_URL: {
    role: 'confera_canary_system',
    memberOf: 'confera_system',
    attributes: 'BYPASSRLS',
  },
} as const;

type SecretName = keyof typeof CANARY_ROLES;

const canaryOf = (name: string): string => `${CANARY}-${name.toLowerCase()}`;

const ADMIN_HOST = 'admin.confera.test';
const PUBLIC_HOST = 'forms.confera.test';

const PATHS = [
  '/health',
  '/health/ready',
  '/',
  '/api/v1/meta',
  '/public/v1/forms/abc',
  '/no/such/route',
];
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
  jest.setTimeout(180_000);

  let superuser: Client;
  let api: RunningApi;
  const env: Record<string, string | undefined> = validProductionEnvironment();

  const dropCanaryRoles = async (): Promise<void> => {
    for (const { role } of Object.values(CANARY_ROLES)) {
      const exists = await rows(superuser, 'SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.length > 0) {
        await superuser.query(`REVOKE ALL ON DATABASE ${testDatabase.name} FROM ${role}`);
        await superuser.query(`DROP ROLE ${role}`);
      }
    }
  };

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
    await seedTwoOrganisations(superuser);
    await dropCanaryRoles();
    for (const name of Object.keys(CANARY_ROLES) as SecretName[]) {
      const { role, memberOf, attributes } = CANARY_ROLES[name];
      await superuser.query(
        `CREATE ROLE ${role} LOGIN ${attributes} PASSWORD ${superuser.escapeLiteral(canaryOf(name))} IN ROLE ${memberOf}`,
      );
      await superuser.query(`GRANT CONNECT ON DATABASE ${testDatabase.name} TO ${role}`);
      env[name] = addressFor(testDatabase.applicationUrl, role, canaryOf(name));
    }
    api = await startApi(PRODUCTION_ENTRY, env);
  });

  afterAll(async () => {
    await api.stop();
    await dropCanaryRoles();
    await superuser.end();
  });

  it('has a canary in every secret variable of the schema', () => {
    expect(SECRET_VARIABLE_NAMES.slice().sort()).toEqual(Object.keys(CANARY_ROLES).sort());
    for (const name of SECRET_VARIABLE_NAMES) {
      expect(env[name]).toContain(canaryOf(name));
    }
  });

  it('started: the roles were checked and the database answers', async () => {
    expect(api.output()).toContain('database.roles.checked');
    expect(api.output()).toContain('api.started');
    const ready = await api.request('/health/ready');
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.text)).toEqual({ status: 'ok' });
  });

  describe('the application role cannot change the schema (ST-65)', () => {
    let role: Client;

    beforeAll(async () => {
      role = await connect(env.DATABASE_URL ?? '');
    });

    afterAll(async () => {
      await role.end();
    });

    it('is the role the running API uses', async () => {
      const [who] = await rows<{ current_user: string }>(role, 'SELECT current_user');
      expect(who?.current_user).toBe(CANARY_ROLES.DATABASE_URL.role);
    });

    it.each([
      ['create a table', 'CREATE TABLE zz_created_by_the_api (id int)'],
      ['create a temporary table', 'CREATE TEMPORARY TABLE zz_temp (id int)'],
      ['alter a table', 'ALTER TABLE users ADD COLUMN zz_extra text'],
      ['drop a table', 'DROP TABLE user_roles'],
      ['switch row-level security off', 'ALTER TABLE users DISABLE ROW LEVEL SECURITY'],
    ])('cannot %s', async (_name, sql) => {
      expect(await errorCode(() => role.query(sql))).toBe(SQLSTATE.insufficientPrivilege);
    });

    it('and sees no row without an organisation, although the tables hold rows', async () => {
      expect(await rows(role, 'SELECT * FROM users')).toEqual([]);
      const [count] = await rows<{ n: string }>(superuser, 'SELECT count(*) AS n FROM users');
      expect(Number(count?.n)).toBeGreaterThan(0);
    });
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
      // A preflight gets a clear "no".
      if (method === 'OPTIONS') {
        expect(response.status).toBe(405);
        expect(response.headers).not.toHaveProperty('allow');
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

    it.each([
      '/../package.json',
      '/..%2f..%2fpackage.json',
      '/.env',
      '/dist/main.js',
      '/openapi/openapi.json',
    ])('GET %s is not found', async (path) => {
      expect((await api.request(path, { headers: { host: ADMIN_HOST } })).status).toBe(404);
    });
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
  });

  it('logs no SQL statement: query logging does not exist in the production build', () => {
    expect(api.output()).not.toContain('db.query');
    expect(api.output()).not.toMatch(/SELECT|set_config/);
  });

  it('shows no canary in the output or the logs (ST-03)', async () => {
    // Requests that fail and requests that succeed, so that every kind of log line exists.
    await api.request('/health/ready');
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
