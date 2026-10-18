import type { Client } from 'pg';
import { MailWorker } from '../../src/modules/mail/mail-worker';
import {
  CATCHER_RECIPIENT,
  ORIGINAL_RECIPIENT_HEADER,
  STAGING_MARK,
} from '../../src/modules/mail/mail-transport';
import { as, confirmPassword, createActors, type Actors, type SignedIn } from './support/actors';
import { type E2eApp, e2eEnvironment, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';
import { inOrganisation } from './support/forms';

/**
 * ST-50, as far as it can be proven on a developer machine (ADR-27): an application started
 * as the staging instance sends every message to its mail catcher only, whatever mail server
 * an admin configured and whatever the recipient. The configured server (a real public
 * provider here) is never resolved nor reached; no address of the envelope is the
 * recipient's; the original recipient is in a header and in the mail log; the subject is
 * marked. That a production instance refuses the setting, and that a staging instance
 * refuses to start without it, is in src/config/stage-guard.spec.ts. The firewall half of
 * ST-50 (the outgoing mail ports closed) is proven on the staging server (runbook, section 4).
 */
const MAILPIT_WEB = `http://127.0.0.1:${process.env.CONFERA_MAIL_WEB_PORT ?? '8025'}`;
const MAILPIT_SMTP = process.env.CONFERA_MAIL_SMTP_PORT ?? '1025';

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Name: string; Address: string }[];
}

async function caught(original: string): Promise<MailpitSummary[]> {
  const response = await fetch(`${MAILPIT_WEB}/api/v1/messages?limit=200`);
  const { messages } = (await response.json()) as { messages: MailpitSummary[] };
  return messages.filter((message) => message.To.some((to) => to.Name === original));
}

async function headersOf(id: string): Promise<Record<string, string[]>> {
  const response = await fetch(`${MAILPIT_WEB}/api/v1/message/${id}/headers`);
  return (await response.json()) as Record<string, string[]>;
}

describe('the staging mail redirect (ST-50, ADR-27)', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp(
      e2eEnvironment({
        INSTANCE: 'staging',
        STAGING_MAIL_CATCHER: `127.0.0.1:${MAILPIT_SMTP}`,
      }),
    );
    actors = await createActors(e2e, owner);
    admin = actors.sessions.adminA;
    await new Factories(owner).templates(actors.a.organisation.id);
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  it('tells the web application that it is the staging instance (the banner)', async () => {
    const meta = await e2e.admin('/api/v1/meta');
    expect(meta.body).toEqual(expect.objectContaining({ instance: 'staging' }));
  });

  it('sends the test message of a server at a real provider to the catcher only, marked, with the recipient in a header', async () => {
    await confirmPassword(e2e, admin);
    const created = await as(e2e, admin, 'post', '/api/v1/mail-servers').send({
      name: 'Pravi dobavljač (izmišljen nalog)',
      host: 'smtp.gmail.com',
      port: 587,
      tlsMode: 'starttls',
      username: 'ured.izmisljeni@example.test',
      password: 'invented-provider-password-1',
      fromAddress: 'ured@a.example.test',
      fromName: 'Ured',
      isDefault: true,
    });
    expect(created.status).toBe(201);
    const original = `primalac.${String(Date.now())}@stvarni-domen.example.test`;
    const tested = await as(
      e2e,
      admin,
      'post',
      `/api/v1/mail-servers/${(created.body as { id: string }).id}/test-message`,
    ).send({ to: original });
    expect(tested.body).toEqual(expect.objectContaining({ result: 'sent' }));
    const messages = await caught(original);
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message?.Subject.startsWith(`${STAGING_MARK} `)).toBe(true);
    // The only address the catcher was given is its own: no real domain is ever an address.
    expect(message?.To.map((to) => to.Address)).toEqual([CATCHER_RECIPIENT]);
    const headers = await headersOf(message?.ID ?? '');
    expect(headers[ORIGINAL_RECIPIENT_HEADER]).toEqual([original]);
    const [entry] = await inOrganisation<{ recipient: string; diverted: boolean }>(
      owner,
      actors.a.organisation.id,
      "SELECT recipient, diverted FROM mail_log WHERE recipient = $1 AND kind = 'test_message'",
      [original],
    );
    expect(entry).toEqual({ recipient: original, diverted: true });
  });

  it('sends what the worker sends to the catcher as well, and the mail log keeps the original recipient', async () => {
    const original = `pozvani.${String(Date.now())}@stvarni-domen.example.test`;
    await confirmPassword(e2e, admin);
    const invited = await as(e2e, admin, 'post', '/api/v1/users').send({
      email: original,
      displayName: 'Mila Izmišljena',
      role: 'reviewer',
    });
    expect(invited.status).toBe(201);
    await e2e.app.get(MailWorker).tick();
    expect(await caught(original)).toHaveLength(1);
    const log = await as(e2e, admin, 'get', '/api/v1/mail-log?kind=invitation');
    expect((log.body as { items: unknown[] }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: original, diverted: true, result: 'sent' }),
      ]),
    );
  });
});
