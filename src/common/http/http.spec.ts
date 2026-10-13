import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  InternalServerErrorException,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsEmail, IsInt, IsString, Max, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import request from 'supertest';
import { validProductionEnvironment } from '../../config/testing/valid-environment';
import { ADMIN_HOST, createTestApp, PUBLIC_HOST, type TestApp } from '../testing/test-app';
import { ProblemException } from './problem';
import { API_SECURITY_HEADERS } from './security-headers';
import { AdminController, OpsController, PublicController } from './surface';

const CANARY = 'canary-91c0de';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class AuthorDto {
  @IsEmail()
  email!: string;
}

class SampleDto {
  @IsString()
  title!: string;

  @IsInt()
  @Max(10)
  count!: number;

  @ValidateNested()
  @Type(() => AuthorDto)
  author!: AuthorDto;
}

@AdminController('sample')
class SampleAdminController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Post('echo')
  echo(@Body() body: SampleDto) {
    return { title: body.title };
  }

  @Get('unknown-error')
  unknownError(): never {
    // What a database driver throws: a message with SQL, a value and a file path.
    throw Object.assign(
      new Error(
        `duplicate key: INSERT INTO "users" ("email") VALUES ('${CANARY}@example.test') at D:\\Code\\confera_be\\src\\x.ts`,
      ),
      { code: '23505', detail: `Key (email)=(${CANARY}@example.test) already exists.` },
    );
  }

  @Get('thrown-string')
  thrownString(): never {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw `${CANARY} as a string`;
  }

  @Get('internal')
  internal(): never {
    throw new InternalServerErrorException(`${CANARY} in a 500`);
  }

  @Get('teapot')
  teapot(): never {
    throw new HttpException({ secretDetail: CANARY }, 418);
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException(`${CANARY} reason`);
  }

  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException({ message: CANARY, path: '/etc/passwd' });
  }

  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException(CANARY);
  }

  @Get('conflict')
  conflict(): never {
    throw new ProblemException(409, 'conference_code_taken');
  }
}

@PublicController('sample')
class SamplePublicController {
  @Get('ok')
  ok() {
    return { ok: true };
  }
}

@OpsController('ops-sample')
class SampleOpsController {
  @Get()
  ok() {
    return { ok: true };
  }
}

describe('the HTTP layer of the application', () => {
  let test: TestApp;
  const http = () => request(test.app.getHttpServer());
  const admin = (path: string) => http().get(path).set('Host', ADMIN_HOST);

  beforeAll(async () => {
    // Production settings: what a server answers is what is tested.
    test = await createTestApp({
      env: validProductionEnvironment(),
      controllers: [SampleAdminController, SamplePublicController, SampleOpsController],
    });
  });

  afterAll(async () => {
    await test.close();
  });

  describe('an unknown error (ST-10)', () => {
    it.each(['unknown-error', 'thrown-string', 'internal'])(
      '%s answers with a code and a trace id only',
      async (route) => {
        const response = await admin(`/api/v1/sample/${route}`);
        expect(response.status).toBe(500);
        expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(Object.keys(response.body as object).sort()).toEqual(['code', 'traceId']);
        expect(response.body).toEqual({
          code: 'internal_error',
          traceId: expect.stringMatching(UUID),
        });
      },
    );

    it('shows no stack, SQL, path or value', async () => {
      const response = await admin('/api/v1/sample/unknown-error');
      for (const forbidden of [
        CANARY,
        'INSERT',
        'users',
        'example.test',
        'confera_be',
        '.ts',
        'at ',
        'stack',
        '23505',
      ]) {
        expect(response.text).not.toContain(forbidden);
      }
    });

    it('is logged in full under the same trace id', async () => {
      const response = await admin('/api/v1/sample/unknown-error');
      const { traceId } = response.body as { traceId: string };
      const entry = test
        .logs()
        .find((log) => log.msg === 'request.failed' && log.traceId === traceId);
      expect(entry).toEqual(
        expect.objectContaining({
          level: 'error',
          err: expect.objectContaining({ type: 'Error', code: '23505', stack: expect.any(String) }),
        }),
      );
      expect(response.headers['x-trace-id']).toBe(traceId);
    });

    it('does not log the driver detail that holds a personal value', async () => {
      await admin('/api/v1/sample/unknown-error');
      expect(test.logText()).not.toContain('already exists');
    });
  });

  describe('a known error', () => {
    it.each([
      ['forbidden', 403, 'forbidden', 'Forbidden'],
      ['bad-request', 400, 'bad_request', 'Bad Request'],
      ['unavailable', 503, 'service_unavailable', 'Service Unavailable'],
      ['conflict', 409, 'conference_code_taken', 'Conflict'],
      ['teapot', 418, 'request_refused', 'Request Refused'],
      ['no-such-route', 404, 'not_found', 'Not Found'],
    ])('%s answers %i with code %s', async (route, status, code, title) => {
      const response = await admin(`/api/v1/sample/${route}`);
      expect(response.status).toBe(status);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.body).toEqual({ code, title, status, traceId: expect.stringMatching(UUID) });
      // The message of the exception never leaves the server.
      expect(response.text).not.toContain(CANARY);
      expect(response.text).not.toContain('passwd');
    });

    it('a route that does not exist says nothing about the address that was asked', async () => {
      const response = await admin(`/api/v1/${CANARY}/x`);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain(CANARY);
      expect(response.text).not.toContain('Cannot GET');
    });
  });

  describe('input validation', () => {
    const post = (body: unknown) =>
      http()
        .post('/api/v1/sample/echo')
        .set('Host', ADMIN_HOST)
        .send(body as object);

    it('accepts a valid body', async () => {
      const response = await post({
        title: 'Šta je novo',
        count: 3,
        author: { email: 'a@example.test' },
      });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ title: 'Šta je novo' });
    });

    it('answers with field paths and rule codes, never with values', async () => {
      const response = await post({
        title: 7,
        count: 99,
        author: { email: CANARY },
        extra: CANARY,
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: 'validation_failed',
        title: 'Bad Request',
        status: 400,
        traceId: expect.stringMatching(UUID),
        errors: expect.arrayContaining([
          { path: 'title', code: 'isString' },
          { path: 'count', code: 'max' },
          { path: 'author.email', code: 'isEmail' },
          { path: 'extra', code: 'whitelistValidation' },
        ]),
      });
      expect(response.text).not.toContain(CANARY);
    });

    it('answers a body that is not JSON as a problem, without echoing it', async () => {
      const response = await http()
        .post('/api/v1/sample/echo')
        .set('Host', ADMIN_HOST)
        .set('Content-Type', 'application/json')
        .send(`{"title": "${CANARY}`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: 'bad_request',
        title: 'Bad Request',
        status: 400,
        traceId: expect.stringMatching(UUID),
      });
    });

    it('refuses a body above the size limit as a problem', async () => {
      const response = await post({
        title: 'x'.repeat(200_000),
        count: 1,
        author: { email: 'a@example.test' },
      });
      expect(response.status).toBe(413);
      expect((response.body as { code: string }).code).toBe('payload_too_large');
    });
  });

  describe('host separation of the two surfaces (ADR-02, ST-66)', () => {
    it('the admin API answers under the admin host name', async () => {
      const response = await admin('/api/v1/sample/ok');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });

    it('the public API answers under the public host name', async () => {
      const response = await http().get('/public/v1/sample/ok').set('Host', PUBLIC_HOST);
      expect(response.status).toBe(200);
    });

    it.each([
      ['the admin API under the public host name', '/api/v1/sample/ok', PUBLIC_HOST],
      ['the public API under the admin host name', '/public/v1/sample/ok', ADMIN_HOST],
      ['the admin API under an unknown host name', '/api/v1/sample/ok', 'evil.example'],
      ['the admin API under an address', '/api/v1/sample/ok', '127.0.0.1:3001'],
      ['the admin API under a look-alike name', '/api/v1/sample/ok', `${ADMIN_HOST}.evil.example`],
      [
        'the admin API under a host with a user part',
        '/api/v1/sample/ok',
        `${ADMIN_HOST}@evil.example`,
      ],
      ['the public API under an unknown host name', '/public/v1/sample/ok', 'evil.example'],
    ])('%s is not found', async (_name, path, host) => {
      const response = await http().get(path).set('Host', host);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        code: 'not_found',
        title: 'Not Found',
        status: 404,
        traceId: expect.stringMatching(UUID),
      });
    });

    it('is exactly the answer of a route that does not exist', async () => {
      const wrongHost = await http().get('/api/v1/sample/ok').set('Host', PUBLIC_HOST);
      const noRoute = await admin('/api/v1/sample/nothing-here');
      const strip = (body: unknown) => ({ ...(body as object), traceId: '' });
      expect(strip(wrongHost.body)).toEqual(strip(noRoute.body));
      expect(wrongHost.status).toBe(noRoute.status);
    });

    it('ignores X-Forwarded-Host, which a client can send', async () => {
      const response = await http()
        .get('/api/v1/sample/ok')
        .set('Host', PUBLIC_HOST)
        .set('X-Forwarded-Host', ADMIN_HOST)
        .set('Forwarded', `host=${ADMIN_HOST}`);
      expect(response.status).toBe(404);
    });

    it('compares host names without the port and without regard to case', async () => {
      expect((await http().get('/api/v1/sample/ok').set('Host', `${ADMIN_HOST}:8443`)).status).toBe(
        200,
      );
      expect(
        (await http().get('/api/v1/sample/ok').set('Host', ADMIN_HOST.toUpperCase())).status,
      ).toBe(200);
    });

    it.each([ADMIN_HOST, PUBLIC_HOST, 'anything.example', '127.0.0.1'])(
      'an ops route answers under %s',
      async (host) => {
        expect((await http().get('/ops-sample').set('Host', host)).status).toBe(200);
        expect((await http().get('/health').set('Host', host)).status).toBe(200);
      },
    );
  });

  describe('headers of every response (ADR-28)', () => {
    it.each([
      ['a success', '/api/v1/sample/ok'],
      ['a known error', '/api/v1/sample/forbidden'],
      ['an unknown error', '/api/v1/sample/unknown-error'],
      ['a missing route', '/nothing'],
      ['health', '/health'],
    ])('%s carries the security headers and a trace id', async (_name, path) => {
      const response = await admin(path);
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
        expect(response.headers[name.toLowerCase()]).toBe(value);
      }
      expect(response.headers['x-trace-id']).toMatch(UUID);
      expect(response.headers).not.toHaveProperty('x-powered-by');
      expect(
        Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
      ).toEqual([]);
    });

    it('gives every request its own trace id and ignores one sent by the client', async () => {
      const first = await admin('/health').set('X-Trace-Id', CANARY).set('X-Request-Id', CANARY);
      const second = await admin('/health');
      expect(first.headers['x-trace-id']).toMatch(UUID);
      expect(first.headers['x-trace-id']).not.toBe(second.headers['x-trace-id']);
    });

    it('refuses every preflight with 405 and no grant', async () => {
      const response = await http()
        .options('/api/v1/sample/ok')
        .set('Host', ADMIN_HOST)
        .set('Origin', 'https://conference-site.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(response.status).toBe(405);
      expect(response.body).toEqual(expect.objectContaining({ code: 'method_not_allowed' }));
      expect(response.headers).not.toHaveProperty('allow');
    });
  });

  describe('the request log', () => {
    it('holds the route pattern, never the address, the query or a header', async () => {
      await admin(`/api/v1/sample/ok?token=${CANARY}`).set('Cookie', `session=${CANARY}`);
      await admin(`/no-route/${CANARY}`).set('Authorization', `Bearer ${CANARY}`);
      const requests = test.logs().filter((log) => log.msg === 'request');
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'GET', route: '/api/v1/sample/ok', status: 200 }),
          expect.objectContaining({ method: 'GET', route: '(no route)', status: 404 }),
        ]),
      );
      expect(JSON.stringify(requests)).not.toContain(CANARY);
      for (const entry of requests) {
        expect(Object.keys(entry).sort()).toEqual([
          'durationMs',
          'level',
          'method',
          'msg',
          'route',
          'service',
          'status',
          'time',
          'traceId',
        ]);
      }
    });
  });
});

describe('a controller without a surface', () => {
  it('stops the start', async () => {
    @Controller('api/v1/bare')
    class BareController {
      @Get()
      ok() {
        return {};
      }
    }
    await expect(createTestApp({ controllers: [BareController] })).rejects.toThrow(
      /BareController declares no surface/,
    );
  });

  it.each([
    ['an ops controller inside the admin API', () => OpsController('api/v1/hidden')],
    ['an ops controller inside the public API', () => OpsController('public/v1/hidden')],
  ])('%s stops the start', async (_name, decorate) => {
    @decorate()
    class MisplacedController {
      @Get()
      ok() {
        return {};
      }
    }
    await expect(createTestApp({ controllers: [MisplacedController] })).rejects.toThrow(
      /does not belong there/,
    );
  });
});
