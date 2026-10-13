import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_SECURITY_HEADERS } from '../../src/common/http/security-headers';
import { repoRoot } from '../support/run-node';
import { ADMIN_HOST, type E2eApp, PUBLIC_HOST, startE2eApp } from './support/e2e-app';

/**
 * The API end to end (M1-QA-01): HTTP requests through supertest against the real
 * application, with the configuration of a server, on PostgreSQL as the application role.
 *
 * In 0.1.0 the application has three routes. What is tested here is what must hold for
 * every route of every later milestone: one error format, the headers, no CORS grant
 * (ST-65), the two host names (ST-66, routing part) and the request log. The operations
 * are taken from the committed OpenAPI files, so a new route joins these tests by itself.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANARY = 'canary-e2e-7f3a91';

interface OpenApiDocument {
  readonly paths: Record<string, Record<string, unknown>>;
}

function operations(file: string): { method: string; path: string }[] {
  const document = JSON.parse(
    readFileSync(join(repoRoot, 'openapi', file), 'utf8'),
  ) as OpenApiDocument;
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map((method) => ({ method: method.toUpperCase(), path })),
  );
}

/** A path of the document with every parameter replaced by a value that names nothing. */
function concrete(path: string): string {
  return path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000');
}

const ADMIN_OPERATIONS = operations('openapi.json');
const PUBLIC_OPERATIONS = operations('openapi.public.json');

describe('the API, end to end', () => {
  jest.setTimeout(120_000);

  let e2e: E2eApp;
  const version = (
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  ).version;

  beforeAll(async () => {
    e2e = await startE2eApp();
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('the routes of 0.1.0', () => {
    it('GET /health answers ok', async () => {
      const response = await e2e.admin('/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('GET /health/ready answers ok: the database answers the application role', async () => {
      const response = await e2e.admin('/health/ready');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('GET /api/v1/meta answers with the name and the version of the repository', async () => {
      const response = await e2e.admin('/api/v1/meta');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body).toEqual({ name: 'confera-api', version });
    });

    it.each(['/health', '/health/ready'])('%s answers under any host name', async (path) => {
      for (const host of [ADMIN_HOST, PUBLIC_HOST, 'anything.example', '127.0.0.1:3001']) {
        expect((await e2e.http().get(path).set('Host', host)).status).toBe(200);
      }
    });
  });

  describe('the committed OpenAPI files describe what the application serves', () => {
    it('the admin document has operations to test', () => {
      expect(ADMIN_OPERATIONS).toEqual(
        expect.arrayContaining([{ method: 'GET', path: '/api/v1/meta' }]),
      );
    });

    it.each(ADMIN_OPERATIONS)(
      '$method $path exists under the admin host name: never 404 for the route, never 5xx',
      async ({ method, path }) => {
        const response = await e2e
          .http()
          [method.toLowerCase() as 'get'](concrete(path))
          .set('Host', ADMIN_HOST);
        expect(response.status).toBeLessThan(500);
        const routes = e2e.logs().filter((log) => log.msg === 'request');
        // The request log names the route pattern: the route exists in the application.
        expect(routes.at(-1)).toEqual(expect.objectContaining({ method }));
        expect(routes.at(-1)?.route).not.toBe('(no route)');
      },
    );

    it.each(ADMIN_OPERATIONS)(
      '$method $path is not found under the public host name (ST-66)',
      async ({ method, path }) => {
        for (const host of [PUBLIC_HOST, 'evil.example', '127.0.0.1']) {
          const response = await e2e
            .http()
            [method.toLowerCase() as 'get'](concrete(path))
            .set('Host', host);
          expect(response.status).toBe(404);
          expect(response.body).toEqual({
            code: 'not_found',
            title: 'Not Found',
            status: 404,
            traceId: expect.stringMatching(UUID),
          });
        }
      },
    );

    // Empty in 0.1.0: the public API gets its first route in 0.3.0, and with it this test.
    if (PUBLIC_OPERATIONS.length > 0) {
      it.each(PUBLIC_OPERATIONS)(
        '$method $path is not found under the admin host name (ST-66)',
        async ({ method, path }) => {
          const response = await e2e
            .http()
            [method.toLowerCase() as 'get'](concrete(path))
            .set('Host', ADMIN_HOST);
          expect(response.status).toBe(404);
        },
      );
    }

    it('the public document describes no admin route and the admin one no public route', () => {
      for (const { path } of PUBLIC_OPERATIONS) {
        expect(path).toMatch(/^\/public\/v1\//);
      }
      for (const { path } of ADMIN_OPERATIONS) {
        expect(path).toMatch(/^\/api\/v1\//);
      }
    });
  });

  describe('one error format', () => {
    it.each([
      ['a route that does not exist', 'GET', '/api/v1/nothing-here'],
      ['the root', 'GET', '/'],
      ['a method the route does not have', 'POST', '/api/v1/meta'],
      ['a method the route does not have', 'DELETE', '/health'],
      ['a path with a traversal', 'GET', '/api/v1/../../package.json'],
      ['a path with an encoded traversal', 'GET', '/api/v1/%2e%2e/%2e%2e/.env'],
      ['a path with a null byte', 'GET', '/api/v1/meta%00'],
    ])('%s (%s %s) is a problem, never a page and never a file', async (_name, method, path) => {
      const response = await e2e
        .http()
        [method.toLowerCase() as 'get'](path)
        .set('Host', ADMIN_HOST);
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.body).toEqual({
        code: 'not_found',
        title: 'Not Found',
        status: 404,
        traceId: expect.stringMatching(UUID),
      });
      expect(response.headers['x-trace-id']).toBe((response.body as { traceId: string }).traceId);
    });

    it('says nothing about the address that was asked', async () => {
      const response = await e2e.admin(`/api/v1/${CANARY}/x?token=${CANARY}`);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain(CANARY);
      expect(response.text).not.toContain('Cannot GET');
    });

    it('a body that is not JSON, on a route without a body, is refused without an echo', async () => {
      const response = await e2e
        .http()
        .post('/api/v1/meta')
        .set('Host', ADMIN_HOST)
        .set('Content-Type', 'application/json')
        .send(`{"password": "${CANARY}`);
      expect([400, 404]).toContain(response.status);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.text).not.toContain(CANARY);
    });
  });

  describe('headers of every response', () => {
    const cases: [string, string, string, string][] = [
      ['a success', 'GET', '/api/v1/meta', ADMIN_HOST],
      ['health', 'GET', '/health', ADMIN_HOST],
      ['readiness', 'GET', '/health/ready', PUBLIC_HOST],
      ['a route under the wrong host name', 'GET', '/api/v1/meta', PUBLIC_HOST],
      ['a missing route', 'GET', '/nothing', ADMIN_HOST],
      ['a refused preflight', 'OPTIONS', '/api/v1/meta', ADMIN_HOST],
      ['a HEAD request', 'HEAD', '/api/v1/meta', ADMIN_HOST],
    ];

    it.each(cases)(
      '%s carries the security headers and a trace id',
      async (_n, method, path, host) => {
        const response = await e2e.http()[method.toLowerCase() as 'get'](path).set('Host', host);
        for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
          expect(response.headers[name.toLowerCase()]).toBe(value);
        }
        expect(response.headers['x-trace-id']).toMatch(UUID);
        expect(response.headers).not.toHaveProperty('x-powered-by');
        expect(response.headers).not.toHaveProperty('server');
        expect(response.headers).not.toHaveProperty('set-cookie');
      },
    );

    it('a trace id sent by the client is never used', async () => {
      const response = await e2e
        .admin('/api/v1/meta')
        .set('X-Trace-Id', CANARY)
        .set('X-Request-Id', CANARY)
        .set('Traceparent', `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
      expect(response.headers['x-trace-id']).toMatch(UUID);
      expect(JSON.stringify(response.headers)).not.toContain(CANARY);
      expect(JSON.stringify(response.headers)).not.toContain('a'.repeat(32));
    });
  });

  describe('no response carries a CORS grant (ST-65)', () => {
    const paths = ['/health', '/api/v1/meta', '/public/v1/forms/abc', '/nothing'];
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
    const origins = [
      `https://${ADMIN_HOST}`,
      `https://${PUBLIC_HOST}`,
      'https://conference-site.example',
      'null',
    ];
    const cases = paths.flatMap((path) =>
      methods.flatMap((method) => origins.map((origin) => [method, path, origin] as const)),
    );

    it.each(cases)('%s %s from %s', async (method, path, origin) => {
      const response = await e2e
        .http()
        [method.toLowerCase() as 'get'](path)
        .set('Host', path.startsWith('/public') ? PUBLIC_HOST : ADMIN_HOST)
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type, x-csrf-token, x-form-token');
      expect(
        Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
      ).toEqual([]);
      if (method === 'OPTIONS') {
        // A preflight gets a clear "no", and no list of methods.
        expect(response.status).toBe(405);
        expect(response.headers).not.toHaveProperty('allow');
      }
    });
  });

  describe('many requests at once', () => {
    it('200 interleaved requests of both host names each get their own answer and trace id', async () => {
      const responses = await Promise.all(
        Array.from({ length: 200 }, (_unused, index) => {
          const kind = index % 4;
          if (kind === 0) {
            return e2e.admin('/api/v1/meta').then((r) => ({ kind, r }));
          }
          if (kind === 1) {
            return e2e.public('/api/v1/meta').then((r) => ({ kind, r }));
          }
          if (kind === 2) {
            return e2e.admin('/health/ready').then((r) => ({ kind, r }));
          }
          return e2e.admin(`/nothing/${String(index)}`).then((r) => ({ kind, r }));
        }),
      );
      const expected = [200, 404, 200, 404];
      for (const { kind, r } of responses) {
        expect(r.status).toBe(expected[kind]);
      }
      const traceIds = responses.map(({ r }) => r.headers['x-trace-id']!);
      expect(new Set(traceIds).size).toBe(responses.length);
      // The id in a problem body is the id of its own response, also under load.
      for (const { r } of responses.filter(({ r: response }) => response.status === 404)) {
        expect((r.body as { traceId: string }).traceId).toBe(r.headers['x-trace-id']);
      }
    });
  });

  describe('the request log', () => {
    it('holds the route pattern and the status, never the address, a query, a header or a body', async () => {
      await e2e
        .admin(`/api/v1/meta?token=${CANARY}-query`)
        .set('Cookie', `session=${CANARY}-cookie`)
        .set('Authorization', `Bearer ${CANARY}-bearer`);
      await e2e.admin(`/links/${CANARY}-path`);
      await e2e
        .http()
        .post('/api/v1/meta')
        .set('Host', ADMIN_HOST)
        .send({ password: `${CANARY}-body` });

      const requests = e2e.logs().filter((log) => log.msg === 'request');
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'GET', route: '/api/v1/meta', status: 200 }),
          expect.objectContaining({ method: 'GET', route: '(no route)', status: 404 }),
        ]),
      );
      expect(e2e.logText()).not.toContain(CANARY);
    });

    it('logs no SQL statement and no database address', () => {
      const text = e2e.logText();
      expect(text).not.toContain('db.query');
      expect(text).not.toMatch(/SELECT|set_config/);
      expect(text).not.toContain('postgresql://');
      expect(text).not.toContain('local-only-');
    });
  });
});
