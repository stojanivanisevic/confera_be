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
 * E2-04 (ADR-04, ADR-13): the outbox row holds the address and the kind of a message; the
 * sender "makes the secure link now" and sends. Nothing at that moment asks whether the
 * message is still true: whether the person still has that address, whether the account is
 * still one that may be sent a reset link ("no reset link for invited or deactivated
 * accounts"). A message that waits (no mail server yet, a server that is down, the backoff
 * of an hour) is sent after the account has changed, and its link, which is minted at
 * that moment, is open for 30 minutes.
 *
 * The mail server of these tests points at a port where nothing listens: the link is made
 * and the attempt is logged either way, and that is what is asserted.
 */
describe('a queued message is checked again when it is sent', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;

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
    actors = await createActors(e2e, owner);
    await new Factories(owner).templates(actors.a.organisation.id);
    admin = await signIn(e2e, actors.a.admin);
    await confirmPassword(e2e, admin);
    const server = await as(e2e, admin, 'post', '/api/v1/mail-servers').send({
      name: 'Nema nikoga',
      host: '127.0.0.1',
      port: 1,
      tlsMode: 'none',
      fromAddress: 'office@a.example.test',
      fromName: 'Ured',
      isDefault: true,
    });
    expect(server.status).toBe(201);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  /** Everything queued so far is set aside, so that a tick looks at what the test queued. */
  async function setAsideTheQueue(): Promise<void> {
    await inA(`UPDATE mail_outbox SET status = 'failed' WHERE status = 'queued'`);
  }

  it('does not send a reset link to the old address of a person who has changed it since', async () => {
    const user = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
    await setAsideTheQueue();
    const asked = await post('/api/v1/password-resets').send({ email: user.email });
    expect(asked.status).toBe(202);

    // Before the worker looks at the outbox, the person moves to a new address, by the
    // real route: the request, the link of the sender, the confirmation.
    const session = await signIn(e2e, user);
    const moved = `novi.${Date.now().toString(36)}@a.example.test`;
    expect(
      (
        await as(e2e, session, 'post', '/api/v1/account/email').send({
          password: INVENTED_PASSWORD,
          newEmail: moved,
        })
      ).status,
    ).toBe(202);
    const token = await mintLink(e2e, {
      organisationId: actors.a.organisation.id,
      purpose: 'email_change',
      userId: user.id,
      recipient: moved,
    });
    expect((await post(linkPath('email_change', token))).status).toBe(204);
    // Only the reset is left to send.
    await inA(`UPDATE mail_outbox SET status = 'failed' WHERE kind <> 'password_reset'`);

    await e2e.app.get(MailWorker).tick();

    const toTheOldAddress = await inA<{ kind: string }>(
      `SELECT kind FROM mail_log WHERE recipient = $1 AND kind = 'password_reset'`,
      [user.email],
    );
    const openLinksToTheOldAddress = await inA<{ purpose: string }>(
      `SELECT purpose FROM secure_links
         WHERE user_id = $1 AND recipient = $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [user.id, user.email],
    );
    expect(toTheOldAddress).toEqual([]);
    expect(openLinksToTheOldAddress).toEqual([]);
  });

  it('makes no reset link for an account that was deactivated after the request', async () => {
    const user = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
    await setAsideTheQueue();
    expect((await post('/api/v1/password-resets').send({ email: user.email })).status).toBe(202);

    await confirmPassword(e2e, admin);
    const shown = (await as(e2e, admin, 'get', `/api/v1/users/${user.id}`)).body as {
      version: number;
    };
    const deactivated = await as(e2e, admin, 'post', `/api/v1/users/${user.id}/deactivation`).send({
      version: shown.version,
    });
    expect(deactivated.status).toBe(200);
    await inA(`UPDATE mail_outbox SET status = 'failed' WHERE kind <> 'password_reset'`);

    await e2e.app.get(MailWorker).tick();

    const sent = await inA<{ kind: string }>(
      `SELECT kind FROM mail_log WHERE recipient = $1 AND kind = 'password_reset'`,
      [user.email],
    );
    const links = await inA<{ purpose: string }>(
      `SELECT purpose FROM secure_links WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [user.id],
    );
    expect(sent).toEqual([]);
    expect(links).toEqual([]);
  });
});
