import type { Client } from 'pg';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import { ADMIN_HOST, type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * Odd input on the routes (the error format of README section 6: "an unexpected error
 * carries `code` and `traceId` only", and an answer that is not 5xx for input the API can
 * name). Each case below answers 500 `internal_error` today; the input is a person's or a
 * script's, never a fault of the server.
 */
describe('odd input is a 4xx, never an unexpected error', () => {
  let year = 0;
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    admin = await signIn(e2e, actors.a.admin);
    await confirmPassword(e2e, admin);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  const publicPost = (path: string, body: string) =>
    e2e
      .http()
      .post(path)
      .set('Host', ADMIN_HOST)
      .set('Origin', e2e.config.origins.admin)
      .set('Content-Type', 'application/json')
      .send(body);

  describe('the public routes (E2-07; ADR-03: every failure of sign-in answers alike)', () => {
    // A NUL cannot be stored in a PostgreSQL text value; the look-up of the address fails
    // and the answer is 500, which is not the answer for any other unknown address.
    it('sign-in with a NUL in the address is a failed sign-in', async () => {
      const response = await publicPost(
        '/api/v1/session',
        JSON.stringify({ email: 'a\u0000b@a.example.test', password: 'invented-x' }),
      );
      expect(response.status).toBe(401);
      expect(response.body).toEqual(expect.objectContaining({ code: 'sign_in_failed' }));
    });

    it('a reset request with a NUL in the address answers like every other (202)', async () => {
      const response = await publicPost(
        '/api/v1/password-resets',
        JSON.stringify({ email: 'a\u0000b@a.example.test' }),
      );
      expect(response.status).toBe(202);
    });

    // The body limit is 64 KB; a document of 30 000 nested arrays fits in it, and the
    // framework walks it recursively before any rule of ours sees it.
    it.each([
      ['arrays', '['.repeat(30_000) + ']'.repeat(30_000)],
      ['objects', '{"a":'.repeat(7_000) + '1' + '}'.repeat(7_000)],
    ])('a body of deeply nested %s is refused as a bad request', async (_name, body) => {
      const response = await publicPost('/api/v1/session', body);
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('the admin routes (E2-08)', () => {
    // `IsISO8601()` is not strict: week dates, ordinal dates and 8-digit dates pass it,
    // `new Date()` of them is an Invalid Date, and Prisma refuses that.
    it.each(['2026-W10-1', '20261016', '2026-060', '0000-01-01'])(
      'the audit log filtered from %s',
      async (from) => {
        const response = await as(e2e, admin, 'get', `/api/v1/audit?from=${from}`);
        expect(response.status).toBeLessThan(500);
      },
    );

    it('the audit log filtered to a week date', async () => {
      const response = await as(e2e, admin, 'get', '/api/v1/audit?to=2026-W10-1');
      expect(response.status).toBeLessThan(500);
    });

    it('a search for the users with a NUL in it', async () => {
      const response = await as(e2e, admin, 'get', '/api/v1/users?search=a%00b');
      expect(response.status).toBeLessThan(500);
    });

    // `@IsOptional()` lets null pass for a field that is not nullable, and the service
    // hands null to Prisma.
    it.each([{ name: null }, { mailLogContent: null }])(
      'the organisation profile changed with %j',
      async (change) => {
        const organisation = (await as(e2e, admin, 'get', '/api/v1/organisation')).body as {
          version: number;
        };
        const response = await as(e2e, admin, 'patch', '/api/v1/organisation').send({
          ...change,
          version: organisation.version,
        });
        expect(response.status).toBe(400);
      },
    );

    it('the payment details are given in full or refused (the DTO says: each field is given)', async () => {
      const organisation = (await as(e2e, admin, 'get', '/api/v1/organisation')).body as {
        version: number;
      };
      await confirmPassword(e2e, admin);
      const response = await as(e2e, admin, 'put', '/api/v1/organisation/payment-details').send({
        rsdAccount: null,
        version: organisation.version,
      });
      expect(response.status).toBe(400);
    });

    it.each([
      { name: null },
      { code: null },
      { languages: null },
      { timeZone: null },
      { listedSites: null },
    ])('a conference changed with %j', async (change) => {
      const created = await as(e2e, admin, 'post', '/api/v1/conferences').send({
        name: 'Nule (izmišljeno)',
        code: 'NU',
        editionYear: 2001 + (year += 1),
      });
      expect(created.status).toBe(201);
      const conference = created.body as { id: string; version: number };
      const response = await as(e2e, admin, 'patch', `/api/v1/conferences/${conference.id}`).send({
        ...change,
        version: conference.version,
      });
      expect(response.status).toBe(400);
    });
  });
});
