import type { Client } from 'pg';
import { BRAKE } from '../../src/modules/access/brake.service';
import { DEVICE_COOKIE } from '../../src/modules/access/cookies';
import { type Actors, as, createActors, signIn } from './support/actors';
import { ADMIN_HOST, type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner, rows } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD } from './support/factories';
import { linkPath, mintLink } from './support/links';

/**
 * The brake of sign-in and the limits of a password reset (M2-BE-02, M2-BE-03; ADR-03,
 * ADR-04, SEC-A-14; ST-15). The client address is what the proxy writes into
 * X-Forwarded-For; here the test is that proxy.
 */
describe('the brake (ST-15)', () => {
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

  const attempt = (
    from: string,
    email: string,
    password = 'invented-wrong-one-123',
    cookies = '',
  ) =>
    e2e
      .http()
      .post('/api/v1/session')
      .set('Host', ADMIN_HOST)
      .set('Origin', e2e.config.origins.admin)
      .set('X-Forwarded-For', from)
      .set('Cookie', cookies)
      .send({ email, password });

  async function inOrganisation<T>(organisationId: string, work: () => Promise<T>): Promise<T> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
      return await work();
    } finally {
      await owner.query('COMMIT');
    }
  }

  async function outbox(organisationId: string, kind: string, recipientUserId?: string) {
    return inOrganisation(organisationId, () =>
      rows<{ id: string; recipient_address: string; unique_key: string; created_at: Date }>(
        owner,
        `SELECT id, recipient_address, unique_key, created_at FROM mail_outbox
         WHERE kind = $1 AND ($2::uuid IS NULL OR recipient_user_id = $2) ORDER BY created_at`,
        [kind, recipientUserId ?? null],
      ),
    );
  }

  describe('per account', () => {
    it('while another address hammers the account, its owner signs in from a known browser; from an unknown one not', async () => {
      const owned = actors.sessions.adminB;
      const device = owned.setCookies.find((line) => line.startsWith(`${DEVICE_COOKIE}=`)) ?? '';
      const deviceCookie = device.split(';')[0] ?? '';
      expect(deviceCookie).not.toBe('');

      const hammer = '203.0.113.50';
      for (let index = 0; index <= BRAKE.accountFreeFailures; index += 1) {
        expect((await attempt(hammer, actors.b.admin.email)).status).toBe(401);
      }
      // The right password from an unknown browser is not even looked at now.
      expect((await attempt('203.0.113.51', actors.b.admin.email, INVENTED_PASSWORD)).status).toBe(
        401,
      );
      // The owner's known browser is exempt from the account's brake.
      const known = await attempt(
        '203.0.113.52',
        actors.b.admin.email,
        INVENTED_PASSWORD,
        deviceCookie,
      );
      expect(known.status).toBe(200);
    });

    it('tells the owner once a day, not for every attempt', async () => {
      const notices = await outbox(actors.b.organisation.id, 'sign_in_brake', actors.b.admin.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.recipient_address).toBe(actors.b.admin.email);
      for (let index = 0; index < 3; index += 1) {
        await attempt('203.0.113.53', actors.b.admin.email, INVENTED_PASSWORD);
      }
      expect(
        await outbox(actors.b.organisation.id, 'sign_in_brake', actors.b.admin.id),
      ).toHaveLength(1);
    });
  });

  describe('per address', () => {
    it('an address that fails for many accounts is slowed down for every account; another address is not', async () => {
      const flood = '198.51.100.77';
      for (let index = 0; index <= BRAKE.addressFreeFailures; index += 1) {
        expect((await attempt(flood, `nobody.${String(index)}@a.example.test`)).status).toBe(401);
      }
      expect((await attempt(flood, actors.a.reviewer.email, INVENTED_PASSWORD)).status).toBe(401);
      expect(
        (await attempt('198.51.100.78', actors.a.reviewer.email, INVENTED_PASSWORD)).status,
      ).toBe(200);
    });

    it('a failure of an unknown address is a security event of the instance, with no organisation', async () => {
      const events = await rows<{ user_id: string | null; user_organisation_id: string | null }>(
        owner,
        "SELECT user_id, user_organisation_id FROM security_events WHERE client_address = '198.51.100.77' AND user_id IS NULL",
      );
      expect(events.length).toBeGreaterThanOrEqual(BRAKE.addressFreeFailures);
      expect(events.every((event) => event.user_organisation_id === null)).toBe(true);
    });
  });

  describe('a password reset (ADR-04)', () => {
    const request = (from: string, email: string) =>
      e2e
        .http()
        .post('/api/v1/password-resets')
        .set('Host', ADMIN_HOST)
        .set('Origin', e2e.config.origins.admin)
        .set('X-Forwarded-For', from)
        .send({ email });

    it('works while the address is braked for sign-in', async () => {
      expect((await request('198.51.100.77', actors.a.reviewer.email)).status).toBe(202);
      const queued = await outbox(actors.a.organisation.id, 'password_reset', actors.a.reviewer.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.recipient_address).toBe(actors.a.reviewer.email);
    });

    it('a second request inside the cool-down does nothing, and the first link stays valid', async () => {
      // The sender (part B) makes the link at send time; here the test does, as the sender would.
      const token = await mintLink(e2e, {
        organisationId: actors.a.organisation.id,
        purpose: 'password_reset',
        userId: actors.a.reviewer.id,
        recipient: actors.a.reviewer.email,
      });
      expect((await request('198.51.100.79', actors.a.reviewer.email)).status).toBe(202);
      expect(
        await outbox(actors.a.organisation.id, 'password_reset', actors.a.reviewer.id),
      ).toHaveLength(1);
      const page = await e2e.admin(linkPath('password_reset', token));
      expect(page.status).toBe(200);
      expect(page.body).toEqual(expect.objectContaining({ email: actors.a.reviewer.email }));
    });

    it('a daily cap: after three messages in a day a request does nothing', async () => {
      const organisationId = actors.a.organisation.id;
      // The first message is older than the cool-down, so the cap and not the cool-down decides.
      const age = async () =>
        inOrganisation(organisationId, () =>
          owner.query(
            `UPDATE mail_outbox SET created_at = created_at - interval '20 minutes' WHERE kind = 'password_reset' AND recipient_user_id = $1`,
            [actors.a.reviewer.id],
          ),
        );
      await age();
      expect((await request('198.51.100.80', actors.a.reviewer.email)).status).toBe(202);
      await age();
      expect((await request('198.51.100.80', actors.a.reviewer.email)).status).toBe(202);
      await age();
      expect((await request('198.51.100.80', actors.a.reviewer.email)).status).toBe(202);
      expect(await outbox(organisationId, 'password_reset', actors.a.reviewer.id)).toHaveLength(3);
    });

    it('answers 202 alike for an unknown, an invited and a deactivated address, and queues nothing for them', async () => {
      const factories = new Factories(owner);
      const invited = await factories.user(actors.a.organisation, { status: 'invited' });
      const deactivated = await factories.user(actors.a.organisation, { status: 'deactivated' });
      for (const email of ['nobody.here@a.example.test', invited.email, deactivated.email]) {
        const response = await request('198.51.100.81', email);
        expect(response.status).toBe(202);
        expect(response.text).toBe('');
      }
      expect(await outbox(actors.a.organisation.id, 'password_reset', invited.id)).toEqual([]);
      expect(await outbox(actors.a.organisation.id, 'password_reset', deactivated.id)).toEqual([]);
    });
  });

  it('the known-device cookie of one account does not exempt another', async () => {
    const own = await signIn(e2e, actors.a.reviewer);
    const device = own.setCookies.find((line) => line.startsWith(`${DEVICE_COOKIE}=`)) ?? '';
    // Hammer the admin of A, then try the admin with the reviewer's device cookie.
    const hammer = '203.0.113.60';
    for (let index = 0; index <= BRAKE.accountFreeFailures; index += 1) {
      await attempt(hammer, actors.a.admin.email);
    }
    const response = await attempt(
      '203.0.113.61',
      actors.a.admin.email,
      INVENTED_PASSWORD,
      device.split(';')[0],
    );
    expect(response.status).toBe(401);
    expect((await as(e2e, own, 'get', '/api/v1/session')).status).toBe(200);
  });
});
