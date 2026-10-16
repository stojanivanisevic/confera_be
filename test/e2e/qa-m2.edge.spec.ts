import { createServer, type Server, type Socket, connect as connectSocket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Client, QueryResultRow } from 'pg';
import { MailWorker } from '../../src/modules/mail/mail-worker';
import { DEVICE_COOKIE } from '../../src/modules/access/cookies';
import { ABSOLUTE_MS, IDLE_MS } from '../../src/modules/access/session.service';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import {
  ADMIN_HOST,
  type E2eApp,
  e2eEnvironment,
  e2eLocalEnvironment,
  startE2eApp,
} from './support/e2e-app';
import { connectAsOwner, e2eDatabase } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD } from './support/factories';
import { linkPath, mintLink } from './support/links';

/**
 * The edge cases of 0.2.0 that the suites of the milestone leave out (M2-QA-01, M2-QA-03;
 * "Edge cases that apply" of M2 in the milestone plan), written by the Test engineer:
 * double submits, two admins at once, Serbian letters in names and addresses, the failure
 * of SMTP and of the database, time zones in the expiry of a session, pagination, and the
 * parts of ST-17, ST-20 and ST-23 that no other file asks.
 */
const MAILPIT_WEB = `http://127.0.0.1:${process.env.CONFERA_MAIL_WEB_PORT ?? '8025'}`;
const GOOD_PASSWORD = 'invented-Breza-Most-Polje-7';
const SERVER_PASSWORD = 'invented-mail-server-password-2';

async function mailpitCountTo(address: string): Promise<number> {
  const response = await fetch(
    `${MAILPIT_WEB}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  return ((await response.json()) as { messages: unknown[] }).messages.length;
}

describe('edge cases of 0.2.0 (Test engineer)', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;

  async function inOrganisation<T extends QueryResultRow>(
    organisationId: string,
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
      const result = await owner.query<T>(sql, values);
      await owner.query('COMMIT');
      return result.rows;
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }
  const inA = <T extends QueryResultRow>(sql: string, values: unknown[] = []) =>
    inOrganisation<T>(actors.a.organisation.id, sql, values);

  const act = (path: string, body: object) =>
    e2e
      .http()
      .post(path)
      .set('Host', ADMIN_HOST)
      .set('Origin', e2e.config.origins.admin)
      .send(body);

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

  describe('double submits and two admins at once', () => {
    it('an invitation accepted twice at the same moment is used once', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { status: 'invited' });
      const token = await mintLink(e2e, {
        organisationId: person.organisationId,
        purpose: 'invitation',
        userId: person.id,
        recipient: person.email,
      });
      const body = { password: GOOD_PASSWORD, passwordRepeat: GOOD_PASSWORD };
      const answers = await Promise.all([
        act(linkPath('invitation', token), body),
        act(linkPath('invitation', token), body),
        act(linkPath('invitation', token), body),
      ]);
      expect(answers.map(({ status }) => status).sort()).toEqual([204, 404, 404]);
      const used = await inA<{ n: string }>(
        'SELECT count(*)::text AS n FROM secure_links WHERE user_id = $1 AND used_at IS NOT NULL',
        [person.id],
      );
      expect(used[0]?.n).toBe('1');
    });

    it('two admins changing the same conference on the same version: one wins, one is told', async () => {
      const created = await as(e2e, admin, 'post', '/api/v1/conferences').send({
        name: 'Istovremeno (izmišljeno)',
        code: 'IS',
        editionYear: 2031,
      });
      expect(created.status).toBe(201);
      const { id, version } = created.body as { id: string; version: number };
      const other = await signIn(e2e, actors.a.ended);
      const [one, two] = await Promise.all([
        as(e2e, admin, 'patch', `/api/v1/conferences/${id}`).send({ venue: 'Niš', version }),
        as(e2e, other, 'patch', `/api/v1/conferences/${id}`).send({ venue: 'Subotica', version }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
    });
  });

  describe('an email change that meets an invitation', () => {
    it('confirming an address that was invited meanwhile is refused as taken, not a failure', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const mine = await signIn(e2e, person);
      const newEmail = `zauzeta.${String(Date.now())}@a.example.test`;
      const asked = await as(e2e, mine, 'post', '/api/v1/account/email').send({
        password: INVENTED_PASSWORD,
        newEmail,
      });
      expect(asked.status).toBe(202);
      await confirmPassword(e2e, admin);
      const invited = await as(e2e, admin, 'post', '/api/v1/users').send({
        email: newEmail,
        displayName: 'Zauzeta Adresa',
        role: 'reviewer',
      });
      expect(invited.status).toBe(201);
      const token = await mintLink(e2e, {
        organisationId: person.organisationId,
        purpose: 'email_change',
        userId: person.id,
        recipient: newEmail,
      });
      const confirmed = await act(linkPath('email_change', token), {});
      expect(confirmed.status).toBe(409);
      expect(confirmed.body).toEqual(expect.objectContaining({ code: 'email_taken' }));
    });
  });

  describe('Serbian letters in names and addresses', () => {
    const name = 'Ђурђа Šćepanović-Žikić Čađavićka';

    it('a name in both scripts is kept and shown unchanged, and found by any letter case', async () => {
      const invited = await as(e2e, admin, 'post', '/api/v1/users').send({
        email: 'djurdja.scepanovic@a.example.test',
        displayName: name,
        role: 'reviewer',
      });
      expect(invited.status).toBe(201);
      const { id } = invited.body as { id: string };
      const read = await as(e2e, admin, 'get', `/api/v1/users/${id}`);
      expect((read.body as { displayName: string }).displayName).toBe(name);
      for (const search of ['ČAĐAVIĆKA', 'čađavićka', 'ЂУРЂА', 'ђурђа', 'Ć-ŽIKIĆ ČAĐ']) {
        const found = await as(
          e2e,
          admin,
          'get',
          `/api/v1/users?search=${encodeURIComponent(search)}`,
        );
        expect({
          search,
          ids: (found.body as { items: { id: string }[] }).items.map((u) => u.id),
        }).toEqual({ search, ids: [id] });
      }
    });

    it('an address with Serbian letters is refused as a field error, not a failure', async () => {
      for (const email of ['đorđe@a.example.test', 'zika@čačak.example.test']) {
        const response = await as(e2e, admin, 'post', '/api/v1/users').send({
          email,
          displayName: 'Đorđe Probni',
          role: 'reviewer',
        });
        expect({ email, status: response.status }).toEqual({ email, status: 400 });
        expect(response.body).toEqual(
          expect.objectContaining({ errors: [expect.objectContaining({ path: 'email' })] }),
        );
      }
    });

    it('an address is one account whatever its letter case, and signs in in any case', async () => {
      const taken = await as(e2e, admin, 'post', '/api/v1/users').send({
        email: actors.a.reviewer.email.toUpperCase(),
        displayName: 'Dvojnik Probni',
        role: 'reviewer',
      });
      expect(taken.status).toBe(409);
      const signedIn = await signIn(e2e, { email: actors.a.reviewer.email.toUpperCase() });
      expect(signedIn.session.user.id).toBe(actors.a.reviewer.id);
    });
  });

  describe('the address rule everywhere an address enters (ST-23)', () => {
    const bad = [
      'jedan@a.example.test, drugi@a.example.test',
      'jedan@a.example.test,drugi@a.example.test',
      'Mila Probna <mila@a.example.test>',
      'mila@a.example.test\r\nBcc: drugi@a.example.test',
      'mila@a.example.test\nX: y',
      `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.test`,
      'mila@a.example.test ',
      '"mila"@a.example.test',
    ];

    it.each(bad)('an invitation to %j is refused', async (email) => {
      const response = await as(e2e, admin, 'post', '/api/v1/users').send({
        email,
        displayName: 'Mila Probna',
        role: 'reviewer',
      });
      expect(response.status).toBe(400);
    });

    it.each(bad)('a mail server sending as %j is refused', async (fromAddress) => {
      await confirmPassword(e2e, admin);
      const response = await as(e2e, admin, 'post', '/api/v1/mail-servers').send({
        name: 'Adresa',
        host: 'smtp.a.example.test',
        port: 587,
        tlsMode: 'starttls',
        fromAddress,
        fromName: 'Ured',
      });
      expect(response.status).toBe(400);
    });

    it.each(bad)('a test message to %j is refused', async (to) => {
      const [server] = await inA<{ id: string }>(
        `INSERT INTO mail_servers (organisation_id, name, host, port, tls_mode, from_address, from_name)
         VALUES ($1::uuid, 'Proba adrese', 'smtp.a.example.test', 587, 'starttls', 'office@a.example.test', 'Ured') RETURNING id`,
        [actors.a.organisation.id],
      );
      const response = await as(
        e2e,
        admin,
        'post',
        `/api/v1/mail-servers/${server?.id ?? ''}/test-message`,
      ).send({ to });
      expect(response.status).toBe(400);
    });
  });

  describe('every link token on every other purpose’s endpoint (ST-17)', () => {
    const purposes = ['invitation', 'password_reset', 'email_change'] as const;

    it.each(purposes)('a token of %s opens and acts only on its own endpoint', async (purpose) => {
      const person = await new Factories(owner).user(actors.a.organisation, {
        status: purpose === 'invitation' ? 'invited' : 'active',
      });
      const token = await mintLink(e2e, {
        organisationId: person.organisationId,
        purpose,
        userId: person.id,
        recipient: purpose === 'email_change' ? 'nova.adresa@a.example.test' : person.email,
      });
      for (const other of purposes.filter((candidate) => candidate !== purpose)) {
        expect((await e2e.admin(linkPath(other, token))).status).toBe(404);
        const acted = await act(linkPath(other, token), {
          password: GOOD_PASSWORD,
          passwordRepeat: GOOD_PASSWORD,
        });
        expect({ other, status: acted.status }).toEqual({ other, status: 404 });
      }
      expect((await e2e.admin(linkPath(purpose, token))).status).toBe(200);
    });
  });

  describe('a sign-in from a new browser (ST-19, the re-check’s addition)', () => {
    it('tells every active admin once; the same browser again tells nobody', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const notices = async () =>
        (
          await inA<{ recipient_address: string }>(
            `SELECT recipient_address FROM mail_outbox WHERE kind = 'security_notice'
               AND parameters->>'change' = 'new_device_sign_in' AND parameters::text LIKE '%' || $1 || '%'
             ORDER BY 1`,
            [person.id],
          )
        ).map(({ recipient_address }) => recipient_address);
      const first = await signIn(e2e, person);
      const admins = await inA<{ email: string }>(
        `SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id
          WHERE u.status = 'active' AND r.role = 'admin' ORDER BY 1`,
      );
      expect(await notices()).toEqual(admins.map(({ email }) => email));
      const device =
        (first.setCookies.find((line) => line.startsWith(`${DEVICE_COOKIE}=`)) ?? '').split(
          ';',
        )[0] ?? '';
      expect(device).not.toBe('');
      await signIn(e2e, person, INVENTED_PASSWORD, { cookies: device });
      expect(await notices()).toHaveLength(admins.length);
    });
  });

  describe('the sealed password of a mail server (ST-19, ST-20)', () => {
    const KEYS = [
      'credentialSet',
      'credentialSetAt',
      'enabled',
      'fromAddress',
      'fromName',
      'host',
      'id',
      'isDefault',
      'isFallback',
      'name',
      'port',
      'sendRatePerMinute',
      'tlsMode',
      'username',
      'version',
    ];

    it('no answer about a server holds anything but the documented fields, nor the sealed value', async () => {
      await confirmPassword(e2e, admin);
      const created = await as(e2e, admin, 'post', '/api/v1/mail-servers').send({
        name: 'Zapečaćen',
        host: 'smtp.a.example.test',
        port: 465,
        tlsMode: 'implicit',
        username: 'office@a.example.test',
        password: SERVER_PASSWORD,
        fromAddress: 'office@a.example.test',
        fromName: 'Ured',
      });
      expect(created.status).toBe(201);
      const { id, version } = created.body as { id: string; version: number };
      const [row] = await inA<{ password_sealed: string }>(
        'SELECT password_sealed FROM mail_servers WHERE id = $1',
        [id],
      );
      const sealed = row?.password_sealed ?? '';
      expect(sealed).not.toBe('');
      const patched = await as(e2e, admin, 'patch', `/api/v1/mail-servers/${id}`).send({
        name: 'Zapečaćen 2',
        version,
      });
      const one = await as(e2e, admin, 'get', `/api/v1/mail-servers/${id}`);
      const list = await as(e2e, admin, 'get', '/api/v1/mail-servers');
      const listed = (list.body as { items: { id: string }[] }).items.find(
        (item) => item.id === id,
      );
      for (const [answer, body] of [
        ['create', created.body],
        ['patch', patched.body],
        ['get', one.body],
        ['list', listed],
      ] as const) {
        expect({ answer, keys: Object.keys(body as object).sort() }).toEqual({
          answer,
          keys: KEYS,
        });
      }
      for (const text of [created.text, patched.text, one.text, list.text, e2e.logText()]) {
        expect(text).not.toContain(SERVER_PASSWORD);
        expect(text).not.toContain(sealed);
        expect(text).not.toContain(sealed.split(':').at(-1) ?? sealed);
      }
    });
  });

  describe('pagination', () => {
    beforeAll(async () => {
      const factories = new Factories(owner);
      for (let index = 0; index < 7; index += 1) {
        await factories.user(actors.a.organisation, {
          role: 'reviewer',
          displayName: 'Isto Ime (izmišljeno)',
        });
      }
    });

    it('walking the users page by page shows each one exactly once, also when names are equal', async () => {
      const all = await as(e2e, admin, 'get', '/api/v1/users?pageSize=100');
      const total = (all.body as { total: number }).total;
      expect(total).toBeGreaterThan(7);
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(total / 2); page += 1) {
        const response = await as(
          e2e,
          admin,
          'get',
          `/api/v1/users?pageSize=2&page=${String(page)}`,
        );
        seen.push(...(response.body as { items: { id: string }[] }).items.map(({ id }) => id));
      }
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    });

    it('a page after the last is empty and still says the total', async () => {
      const response = await as(e2e, admin, 'get', '/api/v1/users?pageSize=100&page=999');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({ items: [], page: 999 }));
      expect((response.body as { total: number }).total).toBeGreaterThan(0);
    });

    it.each([
      '/api/v1/users?pageSize=0',
      '/api/v1/users?pageSize=-1',
      '/api/v1/users?pageSize=abc',
      '/api/v1/users?page=0',
      '/api/v1/users?page=1.5',
      '/api/v1/users?page=100001',
      '/api/v1/audit?pageSize=0',
      '/api/v1/audit?pageSize=101',
      '/api/v1/audit?page=-3',
      '/api/v1/mail-log?pageSize=101',
      '/api/v1/mail-log?page=0',
    ])('%s is refused as input', async (path) => {
      const response = await as(e2e, admin, 'get', path);
      expect(response.status).toBe(400);
    });

    it('the audit log, page by page, shows each entry exactly once', async () => {
      const all = await as(e2e, admin, 'get', '/api/v1/audit?pageSize=100');
      const total = (all.body as { total: number }).total;
      expect(total).toBeGreaterThan(3);
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(total / 3); page += 1) {
        const response = await as(
          e2e,
          admin,
          'get',
          `/api/v1/audit?pageSize=3&page=${String(page)}`,
        );
        seen.push(...(response.body as { items: { id: string }[] }).items.map(({ id }) => id));
      }
      expect(new Set(seen).size).toBe(total);
      expect(seen).toHaveLength(total);
    });
  });

  describe('time zones in the expiry of a session', () => {
    /** Signs in on an application started while `zone` holds, and checks the expiry. */
    async function expiryHolds(zoned: E2eApp): Promise<void> {
      const seen: Record<string, number> = {};
      const before = Date.now();
      const signedIn = await signIn(zoned, actors.a.reviewer);
      const after = Date.now();
      const idle = new Date(signedIn.session.idleExpiresAt).getTime();
      const absolute = new Date(signedIn.session.absoluteExpiresAt).getTime();
      expect(idle).toBeGreaterThanOrEqual(before + IDLE_MS - 1_000);
      expect(idle).toBeLessThanOrEqual(after + IDLE_MS + 1_000);
      expect(absolute).toBeGreaterThanOrEqual(before + ABSOLUTE_MS - 1_000);
      expect(absolute).toBeLessThanOrEqual(after + ABSOLUTE_MS + 1_000);
      // One second past the idle end: ended.
      await inA(
        `UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE token_hash = $1`,
        [signedIn.tokenHash],
      );
      seen.idleEnded = (await as(zoned, signedIn, 'get', '/api/v1/session')).status;
      // One second past the absolute cap, busy a minute ago: ended.
      const busy = await signIn(zoned, actors.a.reviewer);
      await inA(
        `UPDATE sessions SET absolute_expires_at = now() - interval '1 second', last_used_at = now() - interval '1 minute' WHERE token_hash = $1`,
        [busy.tokenHash],
      );
      seen.capEnded = (await as(zoned, busy, 'get', '/api/v1/session')).status;
      // The password given again six minutes ago is no longer valid (5 minutes).
      const confirming = await signIn(zoned, actors.a.admin);
      await confirmPassword(zoned, confirming);
      await inA(
        `UPDATE sessions SET password_confirmed_at = now() - interval '6 minutes' WHERE token_hash = $1`,
        [confirming.tokenHash],
      );
      const stale = await as(zoned, confirming, 'put', '/api/v1/organisation/payment-details').send(
        {
          rsdAccount: null,
          eurIban: null,
          eurSwift: null,
          eurBankName: null,
          paypalPayee: null,
          version: 99,
        },
      );
      seen.staleConfirmation = stale.status;
      // A reset link that ended a second ago is not found.
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const token = await mintLink(zoned, {
        organisationId: person.organisationId,
        purpose: 'password_reset',
        userId: person.id,
        recipient: person.email,
      });
      await inA(
        `UPDATE secure_links SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
        [person.id],
      );
      seen.expiredLink = (await zoned.admin(linkPath('password_reset', token))).status;
      expect(seen).toEqual({
        idleEnded: 401,
        capEnded: 401,
        staleConfirmation: 403,
        expiredLink: 404,
      });
    }

    it('nothing moves with the time zone of the process of the API', async () => {
      const previous = process.env.TZ;
      process.env.TZ = 'Pacific/Kiritimati';
      const zoned = await startE2eApp();
      try {
        await expiryHolds(zoned);
      } finally {
        await zoned.close();
        if (previous === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previous;
        }
      }
    });

    it('nothing moves with the time zone of the database server (Europe/Belgrade, where it may well run)', async () => {
      const database = e2eDatabase.name;
      await owner.query(`ALTER DATABASE "${database}" SET timezone TO 'Europe/Belgrade'`);
      const zoned = await startE2eApp();
      try {
        await expiryHolds(zoned);
      } finally {
        await zoned.close();
        await owner.query(`ALTER DATABASE "${database}" RESET timezone`);
      }
    });
  });

  describe('the database goes away', () => {
    interface Relay {
      readonly port: number;
      cut(): Promise<void>;
      restore(): Promise<void>;
    }

    async function relayTo(host: string, port: number): Promise<Relay> {
      const sockets = new Set<Socket>();
      let server: Server | undefined;
      let listenPort = 0;
      const listen = () =>
        new Promise<void>((resolve, reject) => {
          const created = createServer((client) => {
            const upstream = connectSocket(port, host);
            for (const socket of [client, upstream]) {
              sockets.add(socket);
              socket.on('error', () => undefined);
              socket.on('close', () => sockets.delete(socket));
            }
            client.pipe(upstream);
            upstream.pipe(client);
          });
          created.on('error', reject);
          created.listen(listenPort, '127.0.0.1', () => {
            server = created;
            listenPort = (created.address() as AddressInfo).port;
            resolve();
          });
        });
      await listen();
      return {
        port: listenPort,
        cut: () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server?.close(() => {
              resolve();
            });
          }),
        restore: listen,
      };
    }

    function through(address: string, port: number): string {
      const url = new URL(address);
      url.hostname = '127.0.0.1';
      url.port = String(port);
      return url.toString();
    }

    it('sign-in and a signed-in request answer in the error format, set no cookie and end no session; afterwards all works', async () => {
      const target = new URL(e2eDatabase.applicationUrl);
      const relay = await relayTo(target.hostname, Number(target.port));
      const cut = await startE2eApp(
        e2eEnvironment({
          DATABASE_URL: through(e2eDatabase.applicationUrl, relay.port),
          SYSTEM_DATABASE_URL: through(e2eDatabase.systemUrl, relay.port),
        }),
      );
      try {
        const signedIn = await signIn(cut, actors.a.reviewer);
        await relay.cut();
        const signInAnswer = await cut
          .http()
          .post('/api/v1/session')
          .set('Host', ADMIN_HOST)
          .set('Origin', cut.config.origins.admin)
          .send({ email: actors.a.reviewer.email, password: INVENTED_PASSWORD });
        expect(signInAnswer.status).toBeGreaterThanOrEqual(500);
        expect(signInAnswer.headers['content-type']).toContain('application/problem+json');
        expect(signInAnswer.headers['set-cookie']).toBeUndefined();
        const read = await as(cut, signedIn, 'get', '/api/v1/session');
        expect(read.status).toBeGreaterThanOrEqual(500);
        expect(read.headers['set-cookie']).toBeUndefined();
        await relay.restore();
        // The session survived the outage: it was not ended for want of a database.
        let back = 0;
        for (let attempt = 0; attempt < 30 && back !== 200; attempt += 1) {
          back = (await as(cut, signedIn, 'get', '/api/v1/session')).status;
          if (back !== 200) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        expect(back).toBe(200);
        expect(cut.logText()).not.toContain(INVENTED_PASSWORD);
      } finally {
        await relay.cut();
        await cut.close();
      }
    });
  });

  describe('SMTP failure, the fallback and the worker of two instances (mail catcher)', () => {
    let local: E2eApp;
    let second: E2eApp;
    let adminLocal: SignedIn;

    beforeAll(async () => {
      local = await startE2eApp(e2eLocalEnvironment());
      second = await startE2eApp(e2eLocalEnvironment());
      await new Factories(owner).templates(actors.a.organisation.id);
      adminLocal = await signIn(local, actors.a.admin);
    });

    afterAll(async () => {
      await local.close();
      await second.close();
    });

    async function invite(app: E2eApp, email: string): Promise<string> {
      await confirmPassword(app, adminLocal);
      const response = await as(app, adminLocal, 'post', '/api/v1/users').send({
        email,
        displayName: 'Slanje Probno',
        role: 'reviewer',
      });
      expect(response.status).toBe(201);
      const [message] = await inA<{ id: string }>(
        `SELECT id FROM mail_outbox WHERE recipient_address = $1 AND kind = 'invitation'`,
        [email],
      );
      return message?.id ?? '';
    }

    it('two instances of the application tick at the same moment: each message is tried by one of them, once', async () => {
      // A server where nothing listens: every try fails at once, so the race is all there is.
      await confirmPassword(local, adminLocal);
      const server = await as(local, adminLocal, 'post', '/api/v1/mail-servers').send({
        name: 'Mailpit',
        host: '127.0.0.1',
        port: 1,
        tlsMode: 'none',
        fromAddress: 'office@a.example.test',
        fromName: 'Ured',
        isDefault: true,
      });
      expect(server.status).toBe(201);
      await inA(`UPDATE mail_outbox SET status = 'failed' WHERE status = 'queued'`);
      for (const letter of ['a', 'b', 'c', 'd', 'e', 'f']) {
        await invite(local, `dvaput.${letter}@a.example.test`);
      }
      const due = await inA<{ id: string }>(`SELECT id FROM mail_outbox WHERE status = 'queued'`);
      expect(due.length).toBeGreaterThanOrEqual(6);
      const [one, two] = await Promise.all([
        local.app.get(MailWorker).tick(),
        second.app.get(MailWorker).tick(),
      ]);
      const tries = await inA<{ id: string; attempts: number; logged: string }>(
        `SELECT m.id, m.attempts, (SELECT count(*) FROM mail_log l WHERE l.message_id = m.id)::text AS logged
           FROM mail_outbox m WHERE m.id = ANY($1::uuid[]) ORDER BY m.id`,
        [due.map(({ id }) => id)],
      );
      expect(tries).toEqual(
        due
          .map(({ id }) => id)
          .sort()
          .map((id) => ({ id, attempts: 1, logged: '1' })),
      );
      expect(one.queued + two.queued).toBe(due.length);
    });

    it('when every server fails, the message waits with backoff, fails after five attempts, and only its last link is open', async () => {
      const servers = (await as(local, adminLocal, 'get', '/api/v1/mail-servers')).body as {
        items: { id: string; name: string; version: number }[];
      };
      const mailpit = servers.items.find((item) => item.name === 'Mailpit');
      await confirmPassword(local, adminLocal);
      const moved = await as(
        local,
        adminLocal,
        'patch',
        `/api/v1/mail-servers/${mailpit?.id ?? ''}`,
      ).send({
        port: 1,
        version: mailpit?.version,
      });
      expect(moved.status).toBe(200);
      await inA(`UPDATE mail_outbox SET status = 'failed' WHERE status = 'queued'`);
      const address = 'nikad.ne.stize@a.example.test';
      const id = await invite(local, address);
      const worker = local.app.get(MailWorker);
      const states: { status: string; attempts: number; next: Date }[] = [];
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        await inA(
          `UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1 AND status = 'queued'`,
          [id],
        );
        await worker.tick();
        const [row] = await inA<{ status: string; attempts: number; next_attempt_at: Date }>(
          'SELECT status, attempts, next_attempt_at FROM mail_outbox WHERE id = $1',
          [id],
        );
        states.push({
          status: row?.status ?? '',
          attempts: row?.attempts ?? 0,
          next: row?.next_attempt_at ?? new Date(0),
        });
      }
      expect(states.map(({ status, attempts }) => `${status}:${String(attempts)}`)).toEqual([
        'queued:1',
        'queued:2',
        'queued:3',
        'queued:4',
        'failed:5',
        'failed:5',
      ]);
      expect(states[0]?.next.getTime() ?? 0).toBeGreaterThan(Date.now());
      expect(await mailpitCountTo(address)).toBe(0);
      const [user] = await inA<{ id: string }>('SELECT id FROM users WHERE email = $1', [address]);
      const open = await inA<{ n: string }>(
        `SELECT count(*)::text AS n FROM secure_links WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
        [user?.id ?? ''],
      );
      expect(Number(open[0]?.n)).toBeLessThanOrEqual(1);
      const failures = await inA<{ n: string }>(
        `SELECT count(*)::text AS n FROM mail_log WHERE message_id = $1 AND result = 'failed'`,
        [id],
      );
      expect(failures[0]?.n).toBe('5');
    });
  });
});
