import type { Client, QueryResultRow } from 'pg';
import { digestOf } from '../../src/modules/access/tokens';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import { type E2eApp, e2eLocalEnvironment, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';
import type { MailWorker } from '../../src/modules/mail/mail-worker';
import { MailWorker as MailWorkerClass } from '../../src/modules/mail/mail-worker';

/**
 * Mail servers, the outbox worker and the mail log (M2-BE-07, M2-BE-08; FR-SMTP-01 to 04,
 * FR-MAIL-06; ST-19, ST-20, ST-23). The first part runs on the application as on a server
 * (STAGE=prod): the rules of a target. The second runs on a developer's stage against the
 * mail catcher of the stack (Mailpit): what arrives, and how often.
 */
const MAILPIT_WEB = `http://127.0.0.1:${process.env.CONFERA_MAIL_WEB_PORT ?? '8025'}`;
const MAILPIT_SMTP = Number(process.env.CONFERA_MAIL_SMTP_PORT ?? '1025');
const SERBIAN = 'Đorđe Šćepanović, Čačak, Žabalj';
const SERVER_PASSWORD = 'invented-mail-server-password-1';

interface MailpitSummary {
  ID: string;
  Subject: string;
  From: { Name: string; Address: string };
  To: { Address: string }[];
}

async function mailpitMessagesTo(address: string): Promise<MailpitSummary[]> {
  const response = await fetch(
    `${MAILPIT_WEB}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  return ((await response.json()) as { messages: MailpitSummary[] }).messages;
}

async function mailpitMessage(
  id: string,
): Promise<{ Subject: string; Text: string; HTML: string; From: { Name: string } }> {
  const response = await fetch(`${MAILPIT_WEB}/api/v1/message/${id}`);
  return (await response.json()) as {
    Subject: string;
    Text: string;
    HTML: string;
    From: { Name: string };
  };
}

describe('mail servers, the worker and the mail log', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let organisationA = '';

  /** A statement as the owner role inside organisation A: the policies apply to the test too. */
  async function inA<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationA]);
      const result = await owner.query<T>(sql, values);
      await owner.query('COMMIT');
      return result.rows;
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
  });

  afterAll(async () => {
    await new Factories(owner).reset();
    await owner.end();
  });

  describe('on a server (STAGE=prod): the rules of ADR-11', () => {
    let e2e: E2eApp;
    let actors: Actors;
    let adminA: SignedIn;

    const server = {
      name: 'Pošta (izmišljeno)',
      host: 'smtp.a.example.test',
      port: 587,
      tlsMode: 'starttls',
      username: 'office@a.example.test',
      password: SERVER_PASSWORD,
      fromAddress: 'office@a.example.test',
      fromName: SERBIAN,
    };

    beforeAll(async () => {
      e2e = await startE2eApp();
      actors = await createActors(e2e, owner);
      organisationA = actors.a.organisation.id;
      adminA = await signIn(e2e, actors.a.admin);
    });

    afterAll(async () => {
      await e2e.close();
    });

    const create = (body: object) => as(e2e, adminA, 'post', '/api/v1/mail-servers').send(body);

    it('asks for the password again before a change of a mail server (ST-19)', async () => {
      const fresh = await signIn(e2e, actors.a.admin);
      const response = await as(e2e, fresh, 'post', '/api/v1/mail-servers').send(server);
      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        expect.objectContaining({ code: 'password_confirmation_required' }),
      );
    });

    it('stores the password sealed, never returns it, and tells every active admin (ST-19, FR-SMTP-01)', async () => {
      await confirmPassword(e2e, adminA);
      const notices = async () =>
        (
          await inA<{ n: string }>(
            `SELECT count(*)::text AS n FROM mail_outbox WHERE organisation_id = $1 AND kind = 'security_notice'`,
            [actors.a.organisation.id],
          )
        )[0]?.n;
      const before = Number(await notices());
      const response = await create(server);
      expect(response.status).toBe(201);
      expect(JSON.stringify(response.body)).not.toContain(SERVER_PASSWORD);
      expect(response.body).toEqual(
        expect.objectContaining({ credentialSet: true, host: 'smtp.a.example.test' }),
      );
      const [stored] = await inA<{ password_sealed: string }>(
        'SELECT password_sealed FROM mail_servers WHERE id = $1',
        [(response.body as { id: string }).id],
      );
      expect(stored?.password_sealed).toMatch(/^v1:k1:/);
      expect(stored?.password_sealed).not.toContain(SERVER_PASSWORD);
      const admins = await inA<{ n: string }>(
        `SELECT count(*)::text AS n FROM users u JOIN user_roles r ON r.user_id = u.id
         WHERE u.organisation_id = $1 AND u.status = 'active' AND r.role = 'admin'`,
        [actors.a.organisation.id],
      );
      expect(Number(await notices()) - before).toBe(Number(admins[0]?.n));
      const read = await as(e2e, adminA, 'get', '/api/v1/mail-servers');
      expect(JSON.stringify(read.body)).not.toContain(SERVER_PASSWORD);
    });

    it('clears the stored password when host, port, user or TLS mode change without a new one (ST-20)', async () => {
      await confirmPassword(e2e, adminA);
      const created = (await create({ ...server, name: 'Cilj' })).body as {
        id: string;
        version: number;
      };
      const patch = (body: object) =>
        as(e2e, adminA, 'patch', `/api/v1/mail-servers/${created.id}`).send(body);

      const renamed = await patch({ name: 'Cilj 2', version: created.version });
      expect(renamed.body).toEqual(expect.objectContaining({ credentialSet: true }));

      for (const change of [
        { host: 'smtp.evil.example.test' },
        { port: 465, tlsMode: 'implicit' },
        { username: 'other@a.example.test' },
      ]) {
        const current = (await as(e2e, adminA, 'get', `/api/v1/mail-servers/${created.id}`))
          .body as { version: number };
        const withPassword = await patch({ password: SERVER_PASSWORD, version: current.version });
        expect(withPassword.body).toEqual(expect.objectContaining({ credentialSet: true }));
        const moved = await patch({
          ...change,
          version: (withPassword.body as { version: number }).version,
        });
        expect(moved.status).toBe(200);
        expect(moved.body).toEqual(
          expect.objectContaining({ credentialSet: false, credentialSetAt: null }),
        );
        const [row] = await inA<{ password_sealed: string | null }>(
          'SELECT password_sealed FROM mail_servers WHERE id = $1',
          [created.id],
        );
        expect(row?.password_sealed).toBeNull();
      }
    });

    it.each([
      ['a server without TLS', { tlsMode: 'none' }, 'tls_required'],
      ['a loopback address', { host: '127.0.0.1' }, 'address_not_allowed'],
      ['a private address', { host: '10.0.0.5' }, 'address_not_allowed'],
      ['a name of the container network', { host: 'mailpit' }, 'address_not_allowed'],
      ['a port that is no mail port', { port: 8025 }, 'port_not_allowed'],
    ])('refuses %s (ST-20)', async (_name, change, code) => {
      await confirmPassword(e2e, adminA);
      const response = await create({ ...server, ...change });
      expect(response.status).toBe(422);
      expect(response.body).toEqual(expect.objectContaining({ code }));
      // The field that breaks the rule is named, for the form (UXUI-M2-10).
      expect((response.body as { errors: { path: string }[] }).errors).toHaveLength(1);
    });

    it('refuses a test message to a loopback target, with a generic answer and no connection (ST-20)', async () => {
      // A row written past the API, as an old one would be.
      const [planted] = await inA<{ id: string }>(
        `INSERT INTO mail_servers (organisation_id, name, host, port, tls_mode, from_address, from_name)
         VALUES ($1::uuid, 'Planted', '127.0.0.1', 25, 'starttls', 'office@a.example.test', 'Office') RETURNING id`,
        [actors.a.organisation.id],
      );
      const response = await as(
        e2e,
        adminA,
        'post',
        `/api/v1/mail-servers/${planted?.id ?? ''}/test-message`,
      ).send({
        to: 'mila@a.example.test',
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ result: 'refused', reason: 'address_not_allowed' });
    });

    it('does not delete a server that a conference uses', async () => {
      await confirmPassword(e2e, adminA);
      const created = (await create({ ...server, name: 'U upotrebi' })).body as {
        id: string;
        version: number;
      };
      const conference = await as(e2e, adminA, 'post', '/api/v1/conferences').send({
        name: 'ITEMA (izmišljeno)',
        code: 'IT',
        mailServerId: created.id,
      });
      expect(conference.status).toBe(201);
      const refused = await as(
        e2e,
        adminA,
        'delete',
        `/api/v1/mail-servers/${created.id}?version=${String(created.version)}`,
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual(expect.objectContaining({ code: 'mail_server_in_use' }));
    });

    it("never shows organisation A's servers to organisation B", async () => {
      const adminB = await signIn(e2e, actors.b.admin);
      const list = await as(e2e, adminB, 'get', '/api/v1/mail-servers');
      expect(list.body).toEqual({ items: [] });
    });
  });

  describe('on a developer stage, against the mail catcher (FR-SMTP-02 to 04, FR-MAIL-06)', () => {
    let e2e: E2eApp;
    let actors: Actors;
    let adminA: SignedIn;
    let worker: MailWorker;
    let factories: Factories;

    const catcher = (overrides: object = {}) => ({
      name: 'Mailpit',
      host: '127.0.0.1',
      port: MAILPIT_SMTP,
      tlsMode: 'none',
      fromAddress: 'office@a.example.test',
      fromName: SERBIAN,
      isDefault: true,
      ...overrides,
    });

    async function addServer(body: object): Promise<{ id: string; version: number }> {
      await confirmPassword(e2e, adminA);
      const response = await as(e2e, adminA, 'post', '/api/v1/mail-servers').send(body);
      expect(response.status).toBe(201);
      return response.body as { id: string; version: number };
    }

    async function invite(email: string): Promise<string> {
      await confirmPassword(e2e, adminA);
      const response = await as(e2e, adminA, 'post', '/api/v1/users').send({
        email,
        displayName: SERBIAN,
        role: 'reviewer',
      });
      expect(response.status).toBe(201);
      const [message] = await inA<{ id: string }>(
        `SELECT id FROM mail_outbox WHERE recipient_address = $1 AND kind = 'invitation'`,
        [email],
      );
      return message?.id ?? '';
    }

    const status = async (id: string) =>
      (
        await inA<{ status: string; attempts: number; last_error_code: string | null }>(
          'SELECT status, attempts, last_error_code FROM mail_outbox WHERE id = $1',
          [id],
        )
      )[0];

    beforeAll(async () => {
      await fetch(`${MAILPIT_WEB}/api/v1/messages`, { method: 'DELETE' });
      await new Factories(owner).reset();
      e2e = await startE2eApp(e2eLocalEnvironment());
      worker = e2e.app.get(MailWorkerClass);
      actors = await createActors(e2e, owner);
      organisationA = actors.a.organisation.id;
      adminA = await signIn(e2e, actors.a.admin);
      factories = new Factories(owner);
      await factories.templates(actors.a.organisation.id);
      await factories.templates(actors.b.organisation.id);
    });

    afterAll(async () => {
      await e2e.close();
    });

    let waitingId = '';
    let waitingUser = '';

    it('lets a message wait for a server while the organisation has none, says so, and stays healthy (ST-27, UXUI-M2-01)', async () => {
      waitingId = await invite('bez.servera@a.example.test');
      await worker.tick();
      expect(await status(waitingId)).toEqual({
        status: 'waiting_for_server',
        attempts: 0,
        last_error_code: 'no_mail_server',
      });
      // The worker leaves it alone, however often it looks.
      await worker.tick();
      expect(await status(waitingId)).toEqual(
        expect.objectContaining({ status: 'waiting_for_server' }),
      );
      const [user] = await inA<{ id: string }>(
        `SELECT id FROM users WHERE email = 'bez.servera@a.example.test'`,
      );
      waitingUser = user?.id ?? '';
      const shown = await as(e2e, adminA, 'get', `/api/v1/users/${waitingUser}`);
      expect(shown.body).toEqual(
        expect.objectContaining({ invitationDelivery: 'waiting_for_server' }),
      );
      const listed = (await as(e2e, adminA, 'get', '/api/v1/users')).body as {
        items: { id: string; invitationDelivery: string | null }[];
      };
      expect(listed.items.find((item) => item.id === waitingUser)?.invitationDelivery).toBe(
        'waiting_for_server',
      );
      expect(
        listed.items.find((item) => item.id === actors.a.admin.id)?.invitationDelivery,
      ).toBeNull();
      expect((await e2e.http().get('/health')).status).toBe(200);
    });

    it('sends the waiting invitation once a server is configured, with a link that lasts from then (UXUI-M2-01)', async () => {
      await addServer(catcher());
      expect(await status(waitingId)).toEqual(expect.objectContaining({ status: 'queued' }));
      const before = Date.now();
      await worker.tick();
      expect(await status(waitingId)).toEqual(expect.objectContaining({ status: 'sent' }));
      expect(await mailpitMessagesTo('bez.servera@a.example.test')).toHaveLength(1);
      const [link] = await inA<{ expires_at: Date }>(
        `SELECT expires_at FROM secure_links WHERE user_id = $1 AND purpose = 'invitation' AND revoked_at IS NULL`,
        [waitingUser],
      );
      // 72 hours from the sending, not from the invitation.
      expect(link?.expires_at.getTime()).toBeGreaterThanOrEqual(
        before + 72 * 60 * 60 * 1000 - 5_000,
      );
      const shown = await as(e2e, adminA, 'get', `/api/v1/users/${waitingUser}`);
      expect(shown.body).toEqual(expect.objectContaining({ invitationDelivery: 'sent' }));
    });

    it('refuses at save a server that sends in clear to another machine, with the field named (UXUI-M2-10)', async () => {
      await confirmPassword(e2e, adminA);
      const response = await as(e2e, adminA, 'post', '/api/v1/mail-servers').send(
        catcher({ name: 'Napolje', host: 'smtp.a.example.test', isDefault: false }),
      );
      expect(response.status).toBe(422);
      expect(response.body).toEqual(
        expect.objectContaining({
          code: 'tls_required',
          errors: [{ path: 'tlsMode', code: 'tls_required' }],
        }),
      );
    });

    it('sends an invitation with a link made at send time; Serbian letters arrive unchanged; the log shows [link] (FR-MAIL-06, FR-SMTP-04, ST-17)', async () => {
      const address = 'pozvana.osoba@a.example.test';
      const id = await invite(address);
      const report = await worker.tick();
      expect(report.sent).toBeGreaterThanOrEqual(1);
      expect(await status(id)).toEqual(expect.objectContaining({ status: 'sent', attempts: 1 }));

      const [summary] = await mailpitMessagesTo(address);
      expect(summary?.From.Name).toBe(SERBIAN);
      const received = await mailpitMessage(summary?.ID ?? '');
      expect(received.Text).toContain(SERBIAN);
      expect(received.Subject).toContain(actors.a.organisation.name);
      const token = /\/invitations\/([A-Za-z0-9_-]{43})/.exec(received.Text)?.[1] ?? '';
      expect(token).not.toBe('');
      // The link works, and it exists nowhere but in the message.
      expect((await e2e.admin(`/api/v1/invitations/${token}`)).status).toBe(200);
      const [link] = await inA<{ n: string }>(
        'SELECT count(*)::text AS n FROM secure_links WHERE token_hash = $1',
        [digestOf(token)],
      );
      expect(link?.n).toBe('1');
      const logged = await inA<{
        subject: string;
        body_html: string;
        body_text: string;
        result: string;
      }>('SELECT subject, body_html, body_text, result FROM mail_log WHERE message_id = $1', [id]);
      expect(logged).toHaveLength(1);
      expect(logged[0]?.result).toBe('sent');
      expect(logged[0]?.body_text).toContain('[link]');
      expect(logged[0]?.body_html).toContain('href="[link]"');
      for (const text of [logged[0]?.subject, logged[0]?.body_html, logged[0]?.body_text]) {
        expect(text).not.toContain(token);
      }
      const outbox = await inA<{ parameters: unknown }>(
        'SELECT parameters FROM mail_outbox WHERE id = $1',
        [id],
      );
      expect(JSON.stringify(outbox)).not.toContain(token);
      expect(e2e.logText()).not.toContain(token);

      // The API of the log, with the content as sent.
      const page = await as(e2e, adminA, 'get', `/api/v1/mail-log?messageId=${id}`);
      expect(page.body).toEqual(expect.objectContaining({ total: 1 }));
      const entryId = (page.body as { items: { id: string }[] }).items[0]?.id ?? '';
      const entry = await as(e2e, adminA, 'get', `/api/v1/mail-log/${entryId}`);
      expect(entry.body).toEqual(
        expect.objectContaining({ recipient: address, result: 'sent', serverName: 'Mailpit' }),
      );
      expect((entry.body as { bodyText: string }).bodyText).toContain('[link]');
    });

    it('sends a message once, also when two ticks run at the same time', async () => {
      const address = 'jednom.samo@a.example.test';
      const id = await invite(address);
      await Promise.all([worker.tick(), worker.tick(), e2e.app.get(MailWorkerClass).tick()]);
      await worker.tick();
      expect(await status(id)).toEqual(expect.objectContaining({ status: 'sent' }));
      expect(await mailpitMessagesTo(address)).toHaveLength(1);
      const [log] = await inA<{ n: string }>(
        'SELECT count(*)::text AS n FROM mail_log WHERE message_id = $1',
        [id],
      );
      expect(log?.n).toBe('1');
    });

    it('tries the fallback when the chosen server fails, and logs both attempts (FR-SMTP-02)', async () => {
      await addServer(catcher({ name: 'Rezerva', isDefault: false, isFallback: true }));
      // The default now points at a port where nothing listens.
      const servers = (await as(e2e, adminA, 'get', '/api/v1/mail-servers')).body as {
        items: { id: string; name: string; version: number }[];
      };
      const primary = servers.items.find((item) => item.name === 'Mailpit');
      await confirmPassword(e2e, adminA);
      await as(e2e, adminA, 'patch', `/api/v1/mail-servers/${primary?.id ?? ''}`).send({
        port: 1,
        version: primary?.version,
      });
      const address = 'preko.rezerve@a.example.test';
      const id = await invite(address);
      await worker.tick();
      expect(await status(id)).toEqual(expect.objectContaining({ status: 'sent' }));
      const attempts = await inA<{
        server_name: string;
        result: string;
        error_code: string | null;
      }>(
        'SELECT server_name, result, error_code FROM mail_log WHERE message_id = $1 ORDER BY sent_at, result',
        [id],
      );
      expect(attempts).toEqual([
        { server_name: 'Mailpit', result: 'failed', error_code: 'connection_failed' },
        { server_name: 'Rezerva', result: 'sent', error_code: null },
      ]);
      expect(await mailpitMessagesTo(address)).toHaveLength(1);
    });

    it("does not send faster than the server's rate", async () => {
      const servers = (await as(e2e, adminA, 'get', '/api/v1/mail-servers')).body as {
        items: { id: string; name: string; version: number }[];
      };
      // A fresh minute for the fallback: its earlier sends are moved out of the window.
      await inA(`UPDATE mail_log SET sent_at = sent_at - interval '2 minutes'`);
      const fallback = servers.items.find((item) => item.name === 'Rezerva');
      await confirmPassword(e2e, adminA);
      await as(e2e, adminA, 'patch', `/api/v1/mail-servers/${fallback?.id ?? ''}`).send({
        sendRatePerMinute: 2,
        version: fallback?.version,
      });
      for (const index of [1, 2, 3, 4, 5]) {
        await invite(`brzina.${String(index)}@a.example.test`);
      }
      // Each invitation also queued a notice to the admins: more than enough for the rate.
      const sentInTheMinute = async () =>
        Number(
          (
            await inA<{ n: string }>(
              `SELECT count(*)::text AS n FROM mail_log
               WHERE server_name = 'Rezerva' AND result = 'sent' AND sent_at > now() - interval '1 minute'`,
            )
          )[0]?.n,
        );
      await worker.tick();
      expect(await sentInTheMinute()).toBe(2);
      const limited = await inA<{ n: string }>(
        `SELECT count(*)::text AS n FROM mail_outbox WHERE status = 'queued'`,
      );
      // The rest wait: the fallback is at its rate and the default does not answer.
      expect(Number(limited[0]?.n)).toBeGreaterThanOrEqual(3);
      // Due again at once: the rate still holds within the minute.
      await inA(`UPDATE mail_outbox SET next_attempt_at = now() WHERE status = 'queued'`);
      await worker.tick();
      expect(await sentInTheMinute()).toBe(2);
    });

    it('keeps only the metadata in the log when the organisation switches content off (FR-SMTP-04)', async () => {
      const profile = (await as(e2e, adminA, 'get', '/api/v1/organisation')).body as {
        version: number;
      };
      const changed = await as(e2e, adminA, 'patch', '/api/v1/organisation').send({
        mailLogContent: false,
        version: profile.version,
      });
      expect(changed.body).toEqual(expect.objectContaining({ mailLogContent: false }));
      await inA(`UPDATE mail_log SET sent_at = sent_at - interval '2 minutes'`);
      await inA(`UPDATE mail_outbox SET next_attempt_at = now() WHERE status = 'queued'`);
      await worker.tick();
      const entries = await inA<{
        subject: string | null;
        body_html: string | null;
        body_text: string | null;
      }>(
        `SELECT subject, body_html, body_text FROM mail_log WHERE result = 'sent' ORDER BY sent_at DESC LIMIT 1`,
      );
      expect(entries[0]).toEqual({ subject: null, body_html: null, body_text: null });
    });

    it('sends a test message through one server, with a generic answer (FR-SMTP-01)', async () => {
      const servers = (await as(e2e, adminA, 'get', '/api/v1/mail-servers')).body as {
        items: { id: string; name: string }[];
      };
      const fallback = servers.items.find((item) => item.name === 'Rezerva');
      const response = await as(
        e2e,
        adminA,
        'post',
        `/api/v1/mail-servers/${fallback?.id ?? ''}/test-message`,
      ).send({
        to: 'proba.servera@a.example.test',
        language: 'sr',
      });
      expect(response.body).toEqual({ result: 'sent', reason: null });
      expect(await mailpitMessagesTo('proba.servera@a.example.test')).toHaveLength(1);
      const primary = servers.items.find((item) => item.name === 'Mailpit');
      const failed = await as(
        e2e,
        adminA,
        'post',
        `/api/v1/mail-servers/${primary?.id ?? ''}/test-message`,
      ).send({
        to: 'proba.servera@a.example.test',
      });
      expect(failed.body).toEqual({ result: 'failed', reason: null });
    });
  });
});
