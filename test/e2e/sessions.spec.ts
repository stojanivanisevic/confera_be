import type { Client } from 'pg';
import { DEVICE_COOKIE, SESSION_COOKIE } from '../../src/modules/access/cookies';
import { ABSOLUTE_MS, IDLE_MS } from '../../src/modules/access/session.service';
import { type Actors, as, createActors, signIn } from './support/actors';
import { ADMIN_HOST, type E2eApp, PUBLIC_HOST, startE2eApp } from './support/e2e-app';
import { connectAsOwner, rows } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD } from './support/factories';

/**
 * Sessions and sign-in (M2-BE-02; ADR-03; ST-13, ST-14, ST-16, ST-61, ST-66).
 */
describe('sessions', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  /** The owner role is bound by row-level security too: a query inside the organisation. */
  async function inA<T>(work: () => Promise<T>): Promise<T> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [actors.a.organisation.id]);
      return await work();
    } finally {
      await owner.query('COMMIT');
    }
  }

  async function sessionIds(userId: string): Promise<
    {
      id: string;
      token_hash: string;
      ended_at: Date | null;
      end_reason: string | null;
      idle_expires_at: Date;
      absolute_expires_at: Date;
    }[]
  > {
    return inA(() =>
      rows(
        owner,
        'SELECT id, token_hash, ended_at, end_reason, idle_expires_at, absolute_expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at',
        [userId],
      ),
    );
  }

  describe('the cookie (ST-13, ST-66)', () => {
    it('has the __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain', () => {
      const line = actors.sessions.adminA.setCookies.find((cookie) =>
        cookie.startsWith(`${SESSION_COOKIE}=`),
      );
      expect(line).toBeDefined();
      expect(SESSION_COOKIE).toMatch(/^__Host-/);
      expect(line).toMatch(/; Path=\/(;|$)/);
      expect(line).toMatch(/; HttpOnly(;|$)/);
      expect(line).toMatch(/; Secure(;|$)/);
      expect(line).toMatch(/; SameSite=Lax(;|$)/);
      expect(line).not.toMatch(/Domain=/i);
      expect(line).toMatch(new RegExp(`; Max-Age=${String(ABSOLUTE_MS / 1000)}(;|$)`));
    });

    it('a device cookie with the same rules is set at the first sign-in of a browser', () => {
      const line = actors.sessions.adminA.setCookies.find((cookie) =>
        cookie.startsWith(`${DEVICE_COOKIE}=`),
      );
      expect(DEVICE_COOKIE).toMatch(/^__Host-/);
      expect(line).toMatch(/; HttpOnly; Secure; SameSite=Lax$/);
    });

    it('a cookie planted for the parent domain under another name is ignored (ST-66)', async () => {
      const token = actors.sessions.adminA.cookie.slice(SESSION_COOKIE.length + 1);
      for (const planted of [
        `confera_session=${token}`,
        `__Secure-confera_session=${token}`,
        `${SESSION_COOKIE.replace('__Host-', '')}=${token}`,
      ]) {
        const response = await e2e.admin('/api/v1/session').set('Cookie', planted);
        expect(response.status).toBe(401);
      }
    });

    it('two session cookies in one request (one of them planted) are none', async () => {
      const own = actors.sessions.adminA.cookie;
      const response = await e2e
        .admin('/api/v1/session')
        .set('Cookie', `${own}; ${SESSION_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
      expect(response.status).toBe(401);
    });

    it('a cookie that is not a token is nobody', async () => {
      for (const value of ['', 'x', "'; DROP TABLE sessions; --", 'A'.repeat(44), 'A'.repeat(42)]) {
        const response = await e2e
          .admin('/api/v1/session')
          .set('Cookie', `${SESSION_COOKIE}=${value}`);
        expect(response.status).toBe(401);
      }
    });
  });

  describe('CSRF (ST-13)', () => {
    const changing = () => e2e.http().delete('/api/v1/session').set('Host', ADMIN_HOST);

    it('a changing request without the header is refused', async () => {
      const response = await changing()
        .set('Origin', e2e.config.origins.admin)
        .set('Cookie', actors.sessions.adminA.cookie);
      expect(response.status).toBe(403);
      expect(response.body).toEqual(expect.objectContaining({ code: 'csrf_refused' }));
    });

    it("with another session's value is refused", async () => {
      const response = await changing()
        .set('Origin', e2e.config.origins.admin)
        .set('Cookie', actors.sessions.adminA.cookie)
        .set('X-CSRF-Token', actors.sessions.reviewerA.csrf);
      expect(response.status).toBe(403);
      expect(response.body).toEqual(expect.objectContaining({ code: 'csrf_refused' }));
    });

    it('the value is never in a cookie', () => {
      for (const line of actors.sessions.adminA.setCookies) {
        expect(line).not.toContain(actors.sessions.adminA.csrf);
      }
    });

    it.each([
      ['no Origin', undefined],
      ['the public host as Origin (ST-66)', () => e2e.config.origins.public],
      ['a foreign Origin', () => 'https://evil.example'],
      ['the admin origin with a path', () => `${e2e.config.origins.admin}/`],
      ['the admin origin in another case', () => e2e.config.origins.admin.toUpperCase()],
      ['null', () => 'null'],
    ])('with %s is refused before the session is looked at', async (_name, origin) => {
      let test = changing()
        .set('Cookie', actors.sessions.adminA.cookie)
        .set('X-CSRF-Token', actors.sessions.adminA.csrf);
      if (origin !== undefined) {
        test = test.set('Origin', origin());
      }
      const response = await test;
      expect(response.status).toBe(403);
      expect(response.body).toEqual(expect.objectContaining({ code: 'origin_refused' }));
      // Still signed in: nothing was changed.
      expect((await as(e2e, actors.sessions.adminA, 'get', '/api/v1/session')).status).toBe(200);
    });

    it('a reading request needs no Origin and no header', async () => {
      const response = await e2e
        .admin('/api/v1/session')
        .set('Cookie', actors.sessions.adminA.cookie);
      expect(response.status).toBe(200);
    });

    it('a public changing request needs the Origin of its surface too', async () => {
      const response = await e2e
        .http()
        .post('/api/v1/session')
        .set('Host', ADMIN_HOST)
        .set('Origin', e2e.config.origins.public)
        .send({ email: actors.a.admin.email, password: INVENTED_PASSWORD });
      expect(response.status).toBe(403);
      expect(response.body).toEqual(expect.objectContaining({ code: 'origin_refused' }));
    });
  });

  describe('sign-in (ST-14, ST-16)', () => {
    it('answers with the user, the organisation, the permissions and the CSRF value', () => {
      const { session } = actors.sessions.adminA;
      expect(session.user).toEqual(
        expect.objectContaining({
          id: actors.a.admin.id,
          email: actors.a.admin.email,
          roles: ['admin'],
        }),
      );
      expect(session.user.permissions).toEqual(
        expect.arrayContaining(['users.manage', 'audit.read']),
      );
      expect(session.organisation).toEqual({
        id: actors.a.organisation.id,
        name: actors.a.organisation.name,
      });
      expect(session.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(session.secondFactor).toBe('not_required');
      expect(session.confirmationValidUntil).toBeNull();
      expect(new Date(session.absoluteExpiresAt).getTime() - Date.now()).toBeGreaterThan(
        ABSOLUTE_MS - 60_000,
      );
      expect(new Date(session.idleExpiresAt).getTime() - Date.now()).toBeLessThanOrEqual(IDLE_MS);
    });

    it('sign-in and the sign-in route are not found under the public host name (ST-66)', async () => {
      const response = await e2e
        .http()
        .post('/api/v1/session')
        .set('Host', PUBLIC_HOST)
        .set('Origin', e2e.config.origins.public)
        .send({ email: actors.a.admin.email, password: INVENTED_PASSWORD });
      expect(response.status).toBe(404);
    });

    it('gives a new session id at every sign-in, and ends the one the browser had', async () => {
      const first = await signIn(e2e, actors.a.reviewer);
      const second = await signIn(e2e, actors.a.reviewer, INVENTED_PASSWORD, {
        cookies: first.cookie,
      });
      expect(second.cookie).not.toBe(first.cookie);
      expect(second.csrf).not.toBe(first.csrf);
      expect((await as(e2e, first, 'get', '/api/v1/session')).status).toBe(401);
      expect((await as(e2e, second, 'get', '/api/v1/session')).status).toBe(200);
      const ended = (await sessionIds(actors.a.reviewer.id)).filter(
        (row) => row.end_reason === 'signed_in_again',
      );
      expect(ended.length).toBeGreaterThanOrEqual(1);
    });

    it('a known browser is not asked to keep a new device cookie', async () => {
      const first = await signIn(e2e, actors.b.reviewer);
      const device = first.setCookies.find((line) => line.startsWith(`${DEVICE_COOKIE}=`)) ?? '';
      const deviceCookie = device.split(';')[0] ?? '';
      expect(deviceCookie).toMatch(new RegExp(`^${DEVICE_COOKIE}=[A-Za-z0-9_-]{43}$`));
      const again = await signIn(e2e, actors.b.reviewer, INVENTED_PASSWORD, {
        cookies: deviceCookie,
      });
      expect(again.setCookies.some((line) => line.startsWith(`${DEVICE_COOKIE}=`))).toBe(false);
    });

    describe('every failure answers alike, within one band of time (ST-16)', () => {
      const attempt = (email: string, password = 'invented-wrong-one-123') =>
        e2e
          .http()
          .post('/api/v1/session')
          .set('Host', ADMIN_HOST)
          .set('Origin', e2e.config.origins.admin)
          .send({ email, password });

      let invited: string;
      let deactivated: string;

      beforeAll(async () => {
        const factories = new Factories(owner);
        invited = (await factories.user(actors.a.organisation, { status: 'invited' })).email;
        deactivated = (await factories.user(actors.a.organisation, { status: 'deactivated' }))
          .email;
      });

      it('unknown, wrong password, invited and deactivated: the same status and body', async () => {
        const answers = await Promise.all([
          attempt('nobody.at.all@a.example.test'),
          attempt(actors.a.admin.email),
          attempt(invited, INVENTED_PASSWORD),
          attempt(deactivated, INVENTED_PASSWORD),
          attempt(''),
        ]);
        for (const response of answers) {
          expect(response.status).toBe(401);
          expect(response.headers['set-cookie']).toBeUndefined();
          const { traceId, ...body } = response.body as Record<string, unknown>;
          expect(traceId).toEqual(expect.any(String));
          expect(body).toEqual({ code: 'sign_in_failed', status: 401, title: 'Unauthorized' });
        }
      });

      it('within one band of time: no answer is quicker than the floor, and the slowest is close to it', async () => {
        const timed = async (email: string, password?: string): Promise<number> => {
          const started = performance.now();
          await attempt(email, password);
          return performance.now() - started;
        };
        const samples = {
          unknown: await timed('nobody.at.all@a.example.test'),
          wrong: await timed(actors.a.admin.email),
          invited: await timed(invited, INVENTED_PASSWORD),
          deactivated: await timed(deactivated, INVENTED_PASSWORD),
        };
        for (const [name, ms] of Object.entries(samples)) {
          expect({ name, ms }).toEqual({ name, ms: expect.any(Number) });
          expect(ms).toBeGreaterThanOrEqual(290);
        }
        // The band: the slowest answer within 400 ms of the fastest (the floor is 300 ms).
        const values = Object.values(samples);
        expect(Math.max(...values) - Math.min(...values)).toBeLessThan(400);
      });
    });
  });

  describe('the life of a session (ST-14, ST-61)', () => {
    it('use renews the idle expiry up to the absolute end; a background refetch does not', async () => {
      const signedIn = await signIn(e2e, actors.a.admin);
      const before = (await sessionIds(actors.a.admin.id)).find(
        (row) => row.ended_at === null && row.token_hash === signedIn.tokenHash,
      );
      // Make the session look an hour old, so that the next use renews it.
      await inA(() =>
        owner.query(
          `UPDATE sessions SET last_used_at = now() - interval '1 hour', idle_expires_at = now() + interval '23 hours' WHERE token_hash = $1`,
          [signedIn.tokenHash],
        ),
      );
      await as(e2e, signedIn, 'get', '/api/v1/session')
        .set('X-Confera-Background', '1')
        .expect(200);
      const [untouched] = await sessionIds(actors.a.admin.id).then((list) =>
        list.filter((row) => row.token_hash === signedIn.tokenHash),
      );
      expect(untouched?.idle_expires_at.getTime()).toBeLessThan(Date.now() + 23.5 * 60 * 60 * 1000);
      await as(e2e, signedIn, 'get', '/api/v1/session').expect(200);
      const [renewed] = await sessionIds(actors.a.admin.id).then((list) =>
        list.filter((row) => row.token_hash === signedIn.tokenHash),
      );
      expect(renewed?.idle_expires_at.getTime()).toBeGreaterThan(
        Date.now() + 23.9 * 60 * 60 * 1000,
      );
      expect(before).toBeDefined();
    });

    it('24 hours without use end it', async () => {
      const signedIn = await signIn(e2e, actors.a.admin);
      await inA(() =>
        owner.query(
          `UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE token_hash = $1`,
          [signedIn.tokenHash],
        ),
      );
      expect((await as(e2e, signedIn, 'get', '/api/v1/session')).status).toBe(401);
      const [row] = (await sessionIds(actors.a.admin.id)).filter(
        (r) => r.token_hash === signedIn.tokenHash,
      );
      expect(row?.end_reason).toBe('expired');
    });

    it('a busy session ends at the absolute cap of 7 days (G2-24)', async () => {
      const signedIn = await signIn(e2e, actors.a.admin);
      // Busy until a minute ago, but signed in 7 days ago.
      await inA(() =>
        owner.query(
          `UPDATE sessions SET created_at = now() - interval '7 days', absolute_expires_at = now() - interval '1 second',
             last_used_at = now() - interval '1 minute', idle_expires_at = now() + interval '23 hours' WHERE token_hash = $1`,
          [signedIn.tokenHash],
        ),
      );
      expect((await as(e2e, signedIn, 'get', '/api/v1/session')).status).toBe(401);
      const [row] = (await sessionIds(actors.a.admin.id)).filter(
        (r) => r.token_hash === signedIn.tokenHash,
      );
      expect(row?.end_reason).toBe('expired');
    });

    it('a renewal never reaches past the absolute end', async () => {
      const signedIn = await signIn(e2e, actors.a.admin);
      await inA(() =>
        owner.query(
          `UPDATE sessions SET last_used_at = now() - interval '1 hour', absolute_expires_at = now() + interval '10 minutes' WHERE token_hash = $1`,
          [signedIn.tokenHash],
        ),
      );
      const response = await as(e2e, signedIn, 'get', '/api/v1/session').expect(200);
      const body = response.body as { idleExpiresAt: string; absoluteExpiresAt: string };
      expect(new Date(body.idleExpiresAt).getTime()).toBeLessThanOrEqual(
        new Date(body.absoluteExpiresAt).getTime(),
      );
    });

    it('sign-out ends the session on the server and clears the cookie', async () => {
      const signedIn = await signIn(e2e, actors.a.admin);
      const response = await as(e2e, signedIn, 'delete', '/api/v1/session').expect(204);
      expect(response.headers['set-cookie']).toEqual([
        expect.stringMatching(new RegExp(`^${SESSION_COOKIE}=; Path=/; Max-Age=0;`)),
      ]);
      expect((await as(e2e, signedIn, 'get', '/api/v1/session')).status).toBe(401);
      const [row] = (await sessionIds(actors.a.admin.id)).filter(
        (r) => r.token_hash === signedIn.tokenHash,
      );
      expect(row?.end_reason).toBe('signed_out');
    });

    it('"sign out everywhere" ends every session of the user', async () => {
      const one = await signIn(e2e, actors.a.reviewer);
      const two = await signIn(e2e, actors.a.reviewer);
      await as(e2e, two, 'delete', '/api/v1/sessions').expect(204);
      expect((await as(e2e, one, 'get', '/api/v1/session')).status).toBe(401);
      expect((await as(e2e, two, 'get', '/api/v1/session')).status).toBe(401);
      const open = (await sessionIds(actors.a.reviewer.id)).filter((row) => row.ended_at === null);
      expect(open).toEqual([]);
    });

    it('a deactivated user is nobody from the next request on', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const signedIn = await signIn(e2e, person);
      await inA(() =>
        owner.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [person.id]),
      );
      expect((await as(e2e, signedIn, 'get', '/api/v1/session')).status).toBe(401);
    });

    it('a session whose second factor is pending is not signed in yet (ready for 0.9.0)', async () => {
      const signedIn = await signIn(e2e, actors.a.admin);
      await inA(() =>
        owner.query(`UPDATE sessions SET second_factor = 'pending' WHERE token_hash = $1`, [
          signedIn.tokenHash,
        ]),
      );
      expect((await as(e2e, signedIn, 'get', '/api/v1/session')).status).toBe(401);
    });
  });

  describe('the password asked again (ADR-03)', () => {
    it('is valid for 5 minutes in that session, and only there', async () => {
      const one = await signIn(e2e, actors.a.admin);
      const two = await signIn(e2e, actors.a.admin);
      const response = await as(e2e, one, 'post', '/api/v1/session/password-confirmation')
        .send({ password: INVENTED_PASSWORD })
        .expect(200);
      const until = new Date(
        (response.body as { confirmationValidUntil: string }).confirmationValidUntil,
      ).getTime();
      expect(until - Date.now()).toBeGreaterThan(4.5 * 60 * 1000);
      expect(until - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
      const sensitive = {
        rsdAccount: null,
        eurIban: null,
        eurSwift: null,
        eurBankName: null,
        paypalPayee: null,
        version: 1,
      };
      expect(
        (await as(e2e, two, 'put', '/api/v1/organisation/payment-details').send(sensitive)).status,
      ).toBe(403);
      await inA(() =>
        owner.query(
          `UPDATE sessions SET password_confirmed_at = now() - interval '6 minutes' WHERE token_hash = $1`,
          [one.tokenHash],
        ),
      );
      const stale = await as(e2e, one, 'put', '/api/v1/organisation/payment-details').send(
        sensitive,
      );
      expect(stale.status).toBe(403);
      expect(stale.body).toEqual(
        expect.objectContaining({ code: 'password_confirmation_required' }),
      );
    });

    it('a wrong password is refused and counts for the brake', async () => {
      const signedIn = await signIn(e2e, actors.a.admin);
      const response = await as(
        e2e,
        signedIn,
        'post',
        '/api/v1/session/password-confirmation',
      ).send({
        password: 'invented-not-the-one-1',
      });
      expect(response.status).toBe(403);
      expect(response.body).toEqual(expect.objectContaining({ code: 'password_incorrect' }));
      const events = await rows<{ kind: string }>(
        owner,
        "SELECT kind FROM security_events WHERE user_id = $1 AND kind = 'password_confirmation_failed'",
        [actors.a.admin.id],
      );
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('the forwarded-for header (ST-25)', () => {
    it('the address is the one the proxy wrote, the last of the header; what a client writes before it changes nothing', async () => {
      // The brake counts failures per address: two forged headers that end in the same
      // address share one counter; a forged address in front of it does not get one of its own.
      const fail = (forwarded: string) =>
        e2e
          .http()
          .post('/api/v1/session')
          .set('Host', ADMIN_HOST)
          .set('Origin', e2e.config.origins.admin)
          .set('X-Forwarded-For', forwarded)
          .send({ email: 'brake.probe@a.example.test', password: 'invented-wrong-one-123' });
      await fail('203.0.113.9, 198.51.100.1');
      await fail('203.0.113.10, 198.51.100.1');
      await fail('198.51.100.1');
      const addresses = await rows<{ client_address: string; n: string }>(
        owner,
        "SELECT client_address, count(*)::text AS n FROM security_events WHERE client_address LIKE '198.51.100.%' OR client_address LIKE '203.0.113.%' GROUP BY 1",
      );
      expect(addresses).toEqual([{ client_address: '198.51.100.1', n: '3' }]);
    });
  });
});
