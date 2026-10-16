import type { Client, QueryResultRow } from 'pg';
import { MailWorker } from '../../src/modules/mail/mail-worker';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import { ADMIN_HOST, type E2eApp, e2eLocalEnvironment, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD } from './support/factories';
import { linkPath, mintLink } from './support/links';

/**
 * SEC-M2-01 (E2-03, rest): a link is made when the outbox sends it (ADR-13). An email
 * change asked for under the old password and not yet delivered must not be delivered with
 * a working link after the password changed (own change or reset), nor after the address
 * changed. Through Mailpit, on a developer stage, as the Security reviewer proved it.
 */
const MAILPIT_WEB = `http://127.0.0.1:${process.env.CONFERA_MAIL_WEB_PORT ?? '8025'}`;
const MAILPIT_SMTP = Number(process.env.CONFERA_MAIL_SMTP_PORT ?? '1025');
const NEW_PASSWORD = 'invented-Nova-Lozinka-Reka-91';

async function mailsTo(address: string): Promise<number> {
  const response = await fetch(
    `${MAILPIT_WEB}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  return ((await response.json()) as { messages: unknown[] }).messages.length;
}

describe('a queued message with a link does not outlive a change of the password (SEC-M2-01)', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  let worker: MailWorker;

  async function inA<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [actors.a.organisation.id]);
      const result = await owner.query<T>(sql, values);
      await owner.query('COMMIT');
      return result.rows;
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  const post = (path: string) =>
    e2e.http().post(path).set('Host', ADMIN_HOST).set('Origin', e2e.config.origins.admin);

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp(e2eLocalEnvironment());
    worker = e2e.app.get(MailWorker);
    actors = await createActors(e2e, owner);
    await new Factories(owner).templates(actors.a.organisation.id);
    admin = await signIn(e2e, actors.a.admin);
    await confirmPassword(e2e, admin);
    const server = await as(e2e, admin, 'post', '/api/v1/mail-servers').send({
      name: 'Mailpit',
      host: '127.0.0.1',
      port: MAILPIT_SMTP,
      tlsMode: 'none',
      fromAddress: 'office@a.example.test',
      fromName: 'Ured',
      isDefault: true,
      // The notices of the other tests must not hold this one back by the rate.
      sendRatePerMinute: 600,
    });
    expect(server.status).toBe(201);
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  /** A person who asked for an email change; the confirmation waits in the outbox. */
  async function queuedEmailChange() {
    const user = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
    const session = await signIn(e2e, user);
    const newEmail = `napadac.${Date.now().toString(36)}.${user.id.slice(0, 4)}@a.example.test`;
    const asked = await as(e2e, session, 'post', '/api/v1/account/email').send({
      password: INVENTED_PASSWORD,
      newEmail,
    });
    expect(asked.status).toBe(202);
    return { user, session, newEmail };
  }

  async function nothingWorksFor(userId: string, newEmail: string): Promise<void> {
    await worker.tick();
    expect(await mailsTo(newEmail)).toBe(0);
    const open = await inA(
      `SELECT id FROM secure_links WHERE user_id = $1 AND purpose = 'email_change' AND used_at IS NULL AND revoked_at IS NULL`,
      [userId],
    );
    expect(open).toEqual([]);
    const rows = await inA<{ status: string; last_error_code: string }>(
      `SELECT status, last_error_code FROM mail_outbox WHERE kind = 'email_change_confirmation' AND recipient_address = $1`,
      [newEmail],
    );
    expect(rows).toEqual([{ status: 'failed', last_error_code: 'superseded' }]);
  }

  it('an own change of the password ends the queued confirmation', async () => {
    const { user, session, newEmail } = await queuedEmailChange();
    const changed = await as(e2e, session, 'post', '/api/v1/account/password').send({
      currentPassword: INVENTED_PASSWORD,
      newPassword: NEW_PASSWORD,
      newPasswordRepeat: NEW_PASSWORD,
    });
    expect(changed.status).toBe(204);
    await nothingWorksFor(user.id, newEmail);
  });

  it('a reset of the password ends the queued confirmation', async () => {
    const { user, newEmail } = await queuedEmailChange();
    const reset = await mintLink(e2e, {
      organisationId: actors.a.organisation.id,
      purpose: 'password_reset',
      userId: user.id,
      recipient: user.email,
    });
    const done = await post(linkPath('password_reset', reset)).send({
      password: NEW_PASSWORD,
      passwordRepeat: NEW_PASSWORD,
    });
    expect(done.status).toBe(204);
    await nothingWorksFor(user.id, newEmail);
  });

  it('a confirmation that escaped the change (it was being sent then) is refused when it is retried', async () => {
    const { user, session, newEmail } = await queuedEmailChange();
    // The row is "sending" at the moment of the change, so the change does not end it ...
    await inA(`UPDATE mail_outbox SET status = 'sending' WHERE recipient_address = $1`, [newEmail]);
    const changed = await as(e2e, session, 'post', '/api/v1/account/password').send({
      currentPassword: INVENTED_PASSWORD,
      newPassword: NEW_PASSWORD,
      newPasswordRepeat: NEW_PASSWORD,
    });
    expect(changed.status).toBe(204);
    // ... and comes back to the queue for its next attempt.
    await inA(
      `UPDATE mail_outbox SET status = 'queued', next_attempt_at = now() WHERE recipient_address = $1`,
      [newEmail],
    );
    await nothingWorksFor(user.id, newEmail);
  });

  it('a confirmation queued after the change is sent and works', async () => {
    const { user, newEmail } = await queuedEmailChange();
    await worker.tick();
    expect(await mailsTo(newEmail)).toBe(1);
    const open = await inA(
      `SELECT id FROM secure_links WHERE user_id = $1 AND purpose = 'email_change' AND used_at IS NULL AND revoked_at IS NULL`,
      [user.id],
    );
    expect(open).toHaveLength(1);
  });
});
