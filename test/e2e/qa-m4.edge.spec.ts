import type { Client } from 'pg';
import { PNG } from 'pngjs';
import { MaintenanceWorker } from '../../src/modules/jobs/maintenance-worker';
import { MailWorker } from '../../src/modules/mail/mail-worker';
import { FilesWorker } from '../../src/modules/files/files-worker';
import { startFakeClamd, type FakeClamd } from '../support/fake-clamd';
import {
  as,
  confirmPassword,
  createActors,
  signIn,
  type Actors,
  type SignedIn,
} from './support/actors';
import { type E2eApp, e2eLocalEnvironment, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';
import {
  abstractAnswers,
  ageTokens,
  freshAddress,
  inOrganisation,
  openForm,
  type OpenForm,
  submit,
  tokenFor,
} from './support/forms';

/**
 * M4-QA-01 edge cases (Test engineer, 0.4.0), against the real application on a developer's
 * stage and the mail catcher. What the builders' suites do not try: two different admins on
 * one submission, a status change sent ten times at once, the Serbian letters as they arrive
 * in the catcher, the search typed the way people type đ without a Serbian keyboard, a dead
 * default server with a fallback for a status email, pages at and past their ends, a header
 * injection through the text for the author, the boundaries of retention, a held email
 * released and discarded at the same moment, and images built to hurt a decoder.
 */
const MAILPIT_WEB = `http://127.0.0.1:${process.env.CONFERA_MAIL_WEB_PORT ?? '8025'}`;
const MAILPIT_SMTP = Number(process.env.CONFERA_MAIL_SMTP_PORT ?? '1025');

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Name: string; Address: string }[];
  Bcc: { Address: string }[] | null;
  Cc: { Address: string }[] | null;
}

async function mailsTo(address: string): Promise<MailpitSummary[]> {
  const response = await fetch(
    `${MAILPIT_WEB}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  return ((await response.json()) as { messages: MailpitSummary[] }).messages;
}

async function mailOf(id: string): Promise<{ HTML: string; Text: string; Subject: string }> {
  const response = await fetch(`${MAILPIT_WEB}/api/v1/message/${id}`);
  return (await response.json()) as never;
}

async function headersOf(id: string): Promise<Record<string, string[]>> {
  const response = await fetch(`${MAILPIT_WEB}/api/v1/message/${id}/headers`);
  return (await response.json()) as Record<string, string[]>;
}

const text = (value: string) => ({ type: 'text', text: value });
const placeholder = (key: string) => ({ type: 'placeholder', key });
const paragraph = (...children: unknown[]) => ({ type: 'paragraph', children });
const doc = (...children: unknown[]) => ({ type: 'doc', children });
const subject = (...children: unknown[]) => ({ type: 'subject', children });

const SERBIAN = 'š č ć ž đ Š Č Ć Ž Đ dž Dž lj nj';

interface Detail {
  id: string;
  status: string;
  version: number;
  statusHistory: { transition: number; email: string; emailId: string | null }[];
}

/** A GIF of the given logical size whose frames are 1x1 pixel each. */
function gifOf(width: number, height: number, frames: number, frame = { w: 1, h: 1 }): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80; // a global colour table of 2 entries
  parts.push(header, Buffer.from([0, 0, 0, 255, 255, 255]));
  for (let n = 0; n < frames; n += 1) {
    // A graphic control extension (a delay: animated), then the image descriptor.
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]));
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(frame.w, 5);
    descriptor.writeUInt16LE(frame.h, 7);
    parts.push(descriptor);
    // LZW minimum code size 2; one sub-block: clear, index 0, end of information.
    parts.push(Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function pngOf(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(200);
  return PNG.sync.write(png);
}

describe('M4-QA-01 edge cases (statuses, status emails, search, mail log, images)', () => {
  jest.setTimeout(600_000);

  let owner: Client;
  let clamd: FakeClamd;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  let second: SignedIn;
  let worker: MailWorker;
  let form: OpenForm;

  const orgA = () => actors.a.organisation.id;

  async function submitOne(
    language: 'en' | 'sr',
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; email: string; reference: string }> {
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    await ageTokens(owner, orgA());
    const answers = abstractAnswers(overrides);
    const response = await submit(e2e, form.slug, formToken, { language, answers }, { address });
    expect(response.status).toBe(201);
    const reference = (response.body as { reference: string }).reference;
    const [row] = await inOrganisation<{ id: string }>(
      owner,
      orgA(),
      'SELECT id FROM submissions WHERE reference = $1',
      [reference],
    );
    const authors = answers.authors as { email: string }[];
    return { id: row?.id ?? '', email: authors[0]?.email ?? '', reference };
  }

  async function detail(id: string, who: SignedIn = admin): Promise<Detail> {
    const response = await as(e2e, who, 'get', `/api/v1/submissions/${id}`);
    expect(response.status).toBe(200);
    return response.body as Detail;
  }

  const post = (who: SignedIn, id: string, body: Record<string, unknown>) =>
    as(e2e, who, 'post', `/api/v1/submissions/${id}/status`).send(body);

  async function preview(who: SignedIn, id: string, body: Record<string, unknown>) {
    const response = await as(e2e, who, 'post', `/api/v1/submissions/${id}/status/preview`).send(
      body,
    );
    expect(response.status).toBe(200);
    return response.body as { previewDigest: string; subject: string; text: string };
  }

  async function outboxOf(id: string, kind: string): Promise<{ id: string; status: string }[]> {
    return inOrganisation(
      owner,
      orgA(),
      'SELECT id, status FROM mail_outbox WHERE submission_id = $1 AND kind = $2',
      [id, kind],
    );
  }

  async function opened(language: 'en' | 'sr' = 'en', overrides: Record<string, unknown> = {}) {
    const one = await submitOne(language, overrides);
    const current = await detail(one.id);
    expect((await post(admin, one.id, { action: 'open', version: current.version })).status).toBe(
      200,
    );
    return one;
  }

  async function templateOf(type: string, language: string) {
    const [row] = await inOrganisation<{ id: string; version: number }>(
      owner,
      orgA(),
      'SELECT id, version FROM mail_templates WHERE type = $1 AND language = $2 AND conference_id IS NULL',
      [type, language],
    );
    return row ?? { id: '', version: 0 };
  }

  beforeAll(async () => {
    owner = await connectAsOwner();
    await fetch(`${MAILPIT_WEB}/api/v1/messages`, { method: 'DELETE' });
    await new Factories(owner).reset();
    clamd = await startFakeClamd('clean');
    e2e = await startE2eApp(e2eLocalEnvironment({ CLAMAV_ADDRESS: clamd.address }));
    worker = e2e.app.get(MailWorker);
    actors = await createActors(e2e, owner);
    await new Factories(owner).templates(orgA());
    admin = actors.sessions.adminA;
    // A second, different admin of organisation A: the "two admins" of the plan.
    const other = await new Factories(owner).user(actors.a.organisation, { role: 'admin' });
    second = await signIn(e2e, other);
    await confirmPassword(e2e, admin);
    const server = await as(e2e, admin, 'post', '/api/v1/mail-servers').send({
      name: 'Mailpit',
      host: '127.0.0.1',
      port: MAILPIT_SMTP,
      tlsMode: 'none',
      fromAddress: 'office@a.example.test',
      fromName: 'Ured Šćepanović',
      isDefault: true,
      sendRatePerMinute: 600,
    });
    expect(server.status).toBe(201);
    form = await openForm(e2e, admin);
  });

  afterAll(async () => {
    await e2e.close();
    await clamd.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  describe('two admins, double submits', () => {
    it('ten identical status changes sent at once: one change, one email, nine told 409', async () => {
      const { id } = await opened();
      const { version } = await detail(id);
      const { previewDigest } = await preview(admin, id, { action: 'accept' });
      const answers = await Promise.all(
        Array.from({ length: 10 }, () =>
          post(admin, id, { action: 'accept', version, previewDigest }),
        ),
      );
      const statuses = answers.map((answer) => answer.status).sort();
      expect(statuses).toEqual([200, ...Array<number>(9).fill(409)]);
      expect(await outboxOf(id, 'submission_accepted')).toHaveLength(1);
      const after = await detail(id);
      expect(after.status).toBe('accepted');
      expect(after.version).toBe(version + 1);
      expect(after.statusHistory.filter((entry) => entry.transition === 6)).toHaveLength(1);
    });

    it('two different admins: one returns with a note, the other accepts, at once; one wins, one email', async () => {
      const { id } = await opened();
      const { version } = await detail(id);
      const note = 'Molimo skratite apstrakt.';
      const shown = await preview(admin, id, { action: 'return', message: note });
      const acceptShown = await preview(second, id, { action: 'accept' });
      const [returned, accepted] = await Promise.all([
        post(admin, id, {
          action: 'return',
          message: note,
          previewDigest: shown.previewDigest,
          version,
        }),
        post(second, id, { action: 'accept', version, previewDigest: acceptShown.previewDigest }),
      ]);
      expect([returned.status, accepted.status].sort()).toEqual([200, 409]);
      const sent = [
        ...(await outboxOf(id, 'submission_returned')),
        ...(await outboxOf(id, 'submission_accepted')),
      ];
      expect(sent).toHaveLength(1);
    });

    it('a preview made before another admin edits the template cannot be sent: preview_outdated, nothing changes', async () => {
      const { id } = await opened('sr');
      const shown = await preview(admin, id, { action: 'return', message: 'Dopunite.' });
      const template = await templateOf('submission_returned', 'sr');
      const edited = await as(e2e, second, 'put', `/api/v1/mail-templates/${template.id}`).send({
        subject: subject(text('Izmenjeno: '), placeholder('reference')),
        body: doc(paragraph(text('Izmenio drugi admin. '), placeholder('message'))),
        version: template.version,
      });
      expect(edited.status).toBe(200);
      const { version } = await detail(id);
      const refused = await post(admin, id, {
        action: 'return',
        message: 'Dopunite.',
        previewDigest: shown.previewDigest,
        version,
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual(expect.objectContaining({ code: 'preview_outdated' }));
      expect((await detail(id)).status).toBe('open');
      expect(await outboxOf(id, 'submission_returned')).toHaveLength(0);
    });

    it('an edit on the author’s behalf on a version another admin has moved on is refused', async () => {
      const { id } = await opened();
      const { version } = await detail(id);
      const { previewDigest } = await preview(second, id, { action: 'accept' });
      expect((await post(second, id, { action: 'accept', version, previewDigest })).status).toBe(
        200,
      );
      const edit = await as(e2e, admin, 'put', `/api/v1/submissions/${id}`).send({
        version,
        answers: abstractAnswers({ title: 'Promenjen naslov' }),
      });
      expect(edit.status).toBe(409);
    });
  });

  describe('Serbian letters', () => {
    it('a Serbian status email arrives in the catcher with every letter intact, in the subject and the body', async () => {
      const title = `Održivost i učešće: ${SERBIAN}`;
      const { id, email } = await opened('sr', { title });
      const message = `Poštovana, dopunite rad.\nŠta: ${SERBIAN}`;
      // A rejection with a text: its Serbian template is not one another test here edits.
      const shown = await preview(admin, id, { action: 'reject', message });
      const { version } = await detail(id);
      expect(
        (
          await post(admin, id, {
            action: 'reject',
            message,
            previewDigest: shown.previewDigest,
            version,
          })
        ).status,
      ).toBe(200);
      await worker.tick();
      const mails = await mailsTo(email);
      const returned = mails.find((mail) => mail.Subject.startsWith('Odluka o Vašoj prijavi'));
      expect(returned?.Subject).toMatch(/^Odluka o Vašoj prijavi [A-Z0-9-]+$/);
      const content = await mailOf(returned?.ID ?? '');
      expect(content.Text).toContain(SERBIAN);
      expect(content.Text).toContain(title);
      expect(content.HTML).toContain(SERBIAN);
      // The sender's name with Serbian letters, encoded (RFC 2047), and read back intact.
      const headers = await headersOf(returned?.ID ?? '');
      expect((headers.From ?? []).join(' ')).toMatch(/=\?UTF-8\?/i);
      const whole = (await (
        await fetch(`${MAILPIT_WEB}/api/v1/message/${returned?.ID ?? ''}`)
      ).json()) as { From: { Name: string } };
      expect(whole.From.Name).toBe('Ured Šćepanović');
    });

    it.each([
      ['djordjevic', 'đ written as dj'],
      [
        'dordevic',
        'đ written as d, as without a Serbian keyboard (the web app’s README: "zivana dordevic")',
      ],
      ['ĐORĐEVIĆ', 'capitals'],
      ['zivana', 'ž written as z'],
    ])('the table finds Živana Đorđević by "%s" (%s)', async (query) => {
      const { reference } = await submitOne('sr');
      const found = await as(
        e2e,
        admin,
        'get',
        `/api/v1/submissions?q=${encodeURIComponent(query)}&pageSize=100`,
      );
      expect(found.status).toBe(200);
      const items = (found.body as { items: { reference: string }[] }).items;
      expect({ query, found: items.some((item) => item.reference === reference) }).toEqual({
        query,
        found: true,
      });
    });
  });

  describe('SMTP failure and the fallback', () => {
    it('a status email whose default server is dead goes out through the fallback; both attempts are logged', async () => {
      await confirmPassword(e2e, admin);
      const servers = (await as(e2e, admin, 'get', '/api/v1/mail-servers')).body as {
        items: { id: string; name: string; version: number }[];
      };
      const primary = servers.items.find((item) => item.name === 'Mailpit');
      const fallback = await as(e2e, admin, 'post', '/api/v1/mail-servers').send({
        name: 'Rezerva',
        host: '127.0.0.1',
        port: MAILPIT_SMTP,
        tlsMode: 'none',
        fromAddress: 'rezerva@a.example.test',
        fromName: 'Rezerva',
        isDefault: false,
        isFallback: true,
        sendRatePerMinute: 600,
      });
      expect(fallback.status).toBe(201);
      const broken = await as(
        e2e,
        admin,
        'patch',
        `/api/v1/mail-servers/${primary?.id ?? ''}`,
      ).send({ port: 9, version: primary?.version });
      expect(broken.status).toBe(200);
      try {
        const { id, email } = await opened('sr');
        await worker.tick();
        const [row] = await outboxOf(id, 'submission_opened');
        expect(row?.status).toBe('sent');
        expect((await mailsTo(email)).length).toBeGreaterThanOrEqual(1);
        const attempts = await inOrganisation<{ result: string; mail_server_id: string }>(
          owner,
          orgA(),
          'SELECT result, mail_server_id FROM mail_log WHERE message_id = $1 ORDER BY sent_at',
          [row?.id],
        );
        expect(attempts.map((attempt) => attempt.result)).toEqual(['failed', 'sent']);

        // Both dead: the status change stands, the email waits for its next attempt.
        const spare = (await as(e2e, admin, 'get', '/api/v1/mail-servers')).body as {
          items: { id: string; name: string; version: number }[];
        };
        const reserve = spare.items.find((item) => item.name === 'Rezerva');
        await confirmPassword(e2e, admin);
        await as(e2e, admin, 'patch', `/api/v1/mail-servers/${reserve?.id ?? ''}`).send({
          port: 9,
          version: reserve?.version,
        });
        const both = await opened('en');
        await worker.tick();
        expect((await detail(both.id)).status).toBe('open');
        const [waiting] = await outboxOf(both.id, 'submission_opened');
        expect(waiting?.status).toBe('queued');
        // Its failed attempt is in the log; a message not done yet is not resent, and another
        // organisation does not find the entry at all.
        const [failed] = await inOrganisation<{ id: string }>(
          owner,
          orgA(),
          'SELECT id FROM mail_log WHERE message_id = $1',
          [waiting?.id],
        );
        expect(failed).toBeDefined();
        const refused = await as(e2e, admin, 'post', `/api/v1/mail-log/${failed?.id ?? ''}/resend`);
        expect(refused.status).toBe(409);
        const foreign = await as(
          e2e,
          actors.sessions.adminB,
          'post',
          `/api/v1/mail-log/${failed?.id ?? ''}/resend`,
        );
        expect(foreign.status).toBe(404);
      } finally {
        await confirmPassword(e2e, admin);
        const now = (await as(e2e, admin, 'get', '/api/v1/mail-servers')).body as {
          items: { id: string; name: string; version: number }[];
        };
        for (const item of now.items) {
          await as(e2e, admin, 'patch', `/api/v1/mail-servers/${item.id}`).send({
            port: MAILPIT_SMTP,
            version: item.version,
          });
        }
      }
    });
  });

  describe('pages', () => {
    it.each([
      ['?page=0', 400],
      ['?page=-1', 400],
      ['?page=1.5', 400],
      ['?page=abc', 400],
      ['?pageSize=0', 400],
      ['?pageSize=-5', 400],
      ['?page=100000', 200],
      ['?page=100001', 400],
      ['?page=9007199254740993', 400],
      ['?page=99999999999999999999', 400],
      ['?pageSize=100&page=100000', 200],
    ])('%s answers %d, never a server error', async (query, expected) => {
      const response = await as(e2e, admin, 'get', `/api/v1/submissions${query}`);
      expect({ query, status: response.status }).toEqual({ query, status: expected });
      if (expected === 200) {
        expect((response.body as { items: unknown[] }).items).toEqual([]);
      }
    });
  });

  describe('hostile text for the author', () => {
    it('a message with line breaks and header lines in a subject stays one line; no Bcc, no second recipient', async () => {
      const template = await templateOf('submission_returned', 'en');
      const saved = await as(e2e, admin, 'put', `/api/v1/mail-templates/${template.id}`).send({
        subject: subject(
          text('Changes: '),
          placeholder('message'),
          text(' / '),
          placeholder('title'),
        ),
        body: doc(paragraph(placeholder('message'))),
        version: template.version,
      });
      expect(saved.status).toBe(200);
      // A title with a line break does not even arrive: the form refuses it.
      const address = freshAddress();
      const { formToken } = await tokenFor(e2e, form.slug, address);
      await ageTokens(owner, orgA());
      const refusedTitle = await submit(
        e2e,
        form.slug,
        formToken,
        {
          language: 'en',
          answers: abstractAnswers({ title: 'Naslov\r\nBcc: zrtva.naslov@napadac.example.test' }),
        },
        { address },
      );
      expect(refusedTitle.status).toBe(400);
      const { id, email } = await opened('en');
      // A carriage return is refused outright; a line feed is a line of the text.
      const withReturn = await as(
        e2e,
        admin,
        'post',
        `/api/v1/submissions/${id}/status/preview`,
      ).send({ action: 'return', message: 'Fix it\r\nBcc: zrtva@napadac.example.test' });
      expect(withReturn.status).toBe(400);
      const message = 'Fix it\nBcc: zrtva@napadac.example.test\nX-Injected: yes';
      const shown = await preview(admin, id, { action: 'return', message });
      expect(shown.subject).not.toMatch(/[\r\n]/);
      const { version } = await detail(id);
      expect(
        (
          await post(admin, id, {
            action: 'return',
            message,
            previewDigest: shown.previewDigest,
            version,
          })
        ).status,
      ).toBe(200);
      await worker.tick();
      const mail = (await mailsTo(email)).find((entry) => entry.Subject.startsWith('Changes'));
      expect(mail).toBeDefined();
      expect(mail?.To.map((to) => to.Address)).toEqual([email]);
      expect(mail?.Bcc ?? []).toEqual([]);
      expect(mail?.Cc ?? []).toEqual([]);
      const headers = await headersOf(mail?.ID ?? '');
      expect(headers['X-Injected']).toBeUndefined();
      expect(headers.Bcc).toBeUndefined();
      expect(await mailsTo('zrtva@napadac.example.test')).toEqual([]);
      expect(await mailsTo('zrtva.naslov@napadac.example.test')).toEqual([]);
    });
  });

  describe('mail log: resend, retention', () => {
    it('a status email resent twice goes out three times, each a copy of what the author was shown', async () => {
      const { id, email } = await opened('sr');
      await worker.tick();
      const [entry] = await inOrganisation<{ id: string }>(
        owner,
        orgA(),
        "SELECT l.id FROM mail_log l JOIN mail_outbox m ON m.id = l.message_id WHERE m.submission_id = $1 AND l.kind = 'submission_opened'",
        [id],
      );
      for (let n = 0; n < 2; n += 1) {
        const resent = await as(e2e, admin, 'post', `/api/v1/mail-log/${entry?.id ?? ''}/resend`);
        expect(resent.status).toBe(200);
        expect(resent.body).toEqual(expect.objectContaining({ resendMode: 'copy' }));
      }
      await worker.tick();
      const [logged] = await inOrganisation<{ subject: string }>(
        owner,
        orgA(),
        'SELECT subject FROM mail_log WHERE id = $1',
        [entry?.id],
      );
      const mails = await mailsTo(email);
      const opens = mails.filter((mail) => mail.Subject === logged?.subject);
      expect(opens).toHaveLength(3);
      const bodies = await Promise.all(opens.map(async (mail) => (await mailOf(mail.ID)).Text));
      expect(new Set(bodies).size).toBe(1);
    });

    it.each([
      [29, 400],
      [3651, 400],
      [30.5, 400],
      [30, 200],
      [3650, 200],
    ])('retention of %d days answers %d', async (days, expected) => {
      const current = await as(e2e, admin, 'get', '/api/v1/mail-log/retention');
      const response = await as(e2e, admin, 'put', '/api/v1/mail-log/retention').send({
        days,
        version: (current.body as { version: number }).version,
      });
      expect({ days, status: response.status }).toEqual({ days, status: expected });
    });

    it('two admins setting retention on one version: one wins, the other is told', async () => {
      const current = await as(e2e, admin, 'get', '/api/v1/mail-log/retention');
      const version = (current.body as { version: number }).version;
      const [a, b] = await Promise.all([
        as(e2e, admin, 'put', '/api/v1/mail-log/retention').send({ days: 100, version }),
        as(e2e, second, 'put', '/api/v1/mail-log/retention').send({ days: 200, version }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it('the retention job keeps a message that still waits, however old, and the history of a purged email still reads', async () => {
      await as(e2e, admin, 'get', '/api/v1/mail-log/retention').then(async (current) =>
        as(e2e, admin, 'put', '/api/v1/mail-log/retention').send({
          days: 30,
          version: (current.body as { version: number }).version,
        }),
      );
      const waiting = await submitOne('en');
      const sent = await opened('en');
      await worker.tick();
      const [message] = await outboxOf(sent.id, 'submission_opened');
      await inOrganisation(
        owner,
        orgA(),
        "UPDATE mail_outbox SET created_at = now() - interval '400 days', status = 'queued', next_attempt_at = now() + interval '1 day' WHERE submission_id = $1",
        [waiting.id],
      );
      await inOrganisation(
        owner,
        orgA(),
        "UPDATE mail_log SET sent_at = now() - interval '400 days' WHERE message_id = $1",
        [message?.id],
      );
      await inOrganisation(
        owner,
        orgA(),
        "UPDATE mail_outbox SET created_at = now() - interval '400 days' WHERE id = $1",
        [message?.id],
      );
      await e2e.app.get(MaintenanceWorker).run();
      const kept = await inOrganisation<{ id: string }>(
        owner,
        orgA(),
        'SELECT id FROM mail_outbox WHERE submission_id = $1',
        [waiting.id],
      );
      expect(kept.length).toBeGreaterThanOrEqual(1);
      expect(await outboxOf(sent.id, 'submission_opened')).toEqual([]);
      // The submission still reads, its history names the email it once sent.
      const after = await detail(sent.id);
      expect(after.statusHistory.find((entry) => entry.transition === 2)?.email).toBe('queued');
    });
  });

  describe('held mail', () => {
    it('released and discarded at the same moment: either, never both; a discarded one is never sent', async () => {
      const { id } = await opened('en');
      const [row] = await outboxOf(id, 'submission_opened');
      await inOrganisation(
        owner,
        orgA(),
        "UPDATE mail_outbox SET status = 'held', held_reason = 'send_breaker_organisation' WHERE id = $1",
        [row?.id],
      );
      const [released, discarded] = await Promise.all([
        as(e2e, admin, 'post', '/api/v1/held-mail/release').send({ ids: [row?.id] }),
        as(e2e, second, 'post', '/api/v1/held-mail/discard').send({ ids: [row?.id] }),
      ]);
      const counts = [
        (released.body as { released?: number }).released ?? -1,
        (discarded.body as { discarded?: number }).discarded ?? -1,
      ];
      expect(counts.sort()).toEqual([0, 1]);
      await worker.tick();
      const [after] = await outboxOf(id, 'submission_opened');
      if ((discarded.body as { discarded: number }).discarded === 1) {
        expect(after?.status).toBe('discarded');
        const resent = await as(e2e, admin, 'post', '/api/v1/held-mail/release').send({
          ids: [row?.id],
        });
        expect(resent.body).toEqual({ released: 0 });
      } else {
        expect(after?.status).toBe('sent');
      }
    });
  });

  describe('images that hurt a decoder (ST-67)', () => {
    const upload = (bytes: Buffer, name: string) =>
      as(e2e, admin, 'post', '/api/v1/mail-images').attach('file', bytes, name);

    it('an animated GIF of three frames is taken as a PNG of its first frame', async () => {
      const response = await upload(gifOf(40, 20, 3), 'animirani.gif');
      expect(response.status).toBe(201);
      expect(response.body).toEqual(
        expect.objectContaining({ type: 'png', width: 40, height: 20 }),
      );
    });

    it('a GIF of 101 frames is refused from its blocks, before any decode', async () => {
      const response = await upload(gifOf(10, 10, 101), 'mnogo.gif');
      expect(response.status).toBe(422);
      expect(response.body).toEqual(expect.objectContaining({ code: 'image_too_many_pixels' }));
    });

    it('a GIF whose screen is small but whose frame claims 65,535 x 65,535 ends quickly as unreadable or refused', async () => {
      const started = performance.now();
      const response = await upload(gifOf(10, 10, 1, { w: 65_535, h: 65_535 }), 'okvir.gif');
      const ms = performance.now() - started;
      expect([201, 422]).toContain(response.status);
      expect(ms).toBeLessThan(10_000);
      const health = await e2e.http().get('/health');
      expect(health.status).toBe(200);
    });

    it('a JPEG whose first frame header is small and a second claims 60,000 x 60,000 ends in bounded time', async () => {
      const sof = (w: number, h: number) =>
        Buffer.from([
          0xff,
          0xc0,
          0x00,
          0x11,
          0x08,
          h >> 8,
          h & 255,
          w >> 8,
          w & 255,
          0x03,
          0x01,
          0x22,
          0x00,
          0x02,
          0x11,
          0x01,
          0x03,
          0x11,
          0x01,
        ]);
      const bytes = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        sof(8, 8),
        sof(60_000, 60_000),
        Buffer.from([0xff, 0xd9]),
      ]);
      const started = performance.now();
      const response = await upload(bytes, 'dva-okvira.jpg');
      expect(response.status).toBe(422);
      expect(performance.now() - started).toBeLessThan(10_000);
    });

    it('eight 16-megapixel PNGs uploaded at once cost no more memory than a few decodes: the decoding is bounded, not one worker per request', async () => {
      const big = pngOf(4_000, 4_000);
      /** The growth of the process's memory (MB) while the uploads run, and how /health answered meanwhile. */
      async function measure(count: number): Promise<{ grewMb: number; health: number[] }> {
        global.gc?.();
        const before = process.memoryUsage().rss;
        let peak = before;
        const sampler = setInterval(() => {
          peak = Math.max(peak, process.memoryUsage().rss);
        }, 25);
        const health: number[] = [];
        const pinger = setInterval(() => {
          const started = performance.now();
          void e2e
            .http()
            .get('/health')
            .then(() => health.push(performance.now() - started));
        }, 250);
        try {
          const answers = await Promise.all(
            Array.from({ length: count }, (_, n) => upload(big, `veliki-${String(n)}.png`)),
          );
          for (const answer of answers) {
            expect([201, 413, 422]).toContain(answer.status);
          }
        } finally {
          clearInterval(sampler);
          clearInterval(pinger);
        }
        return { grewMb: Math.round((peak - before) / 1024 / 1024), health };
      }
      const one = await measure(1);
      const eight = await measure(8);
      process.stdout.write(
        `ST-67 QA: one 16 MP PNG: rss +${String(one.grewMb)} MB; eight at once: rss +${String(eight.grewMb)} MB; /health answered ${String(eight.health.length)} times meanwhile, slowest ${String(Math.round(Math.max(0, ...eight.health)))} ms
`,
      );
      expect(eight.health.length).toBeGreaterThan(0);
      // Each decode is bounded by the header check; their number is not. Two or three at a time
      // would be a bound; eight at once taking eight times the memory is none.
      expect({
        oneMb: one.grewMb,
        eightMb: eight.grewMb,
        bounded: eight.grewMb < Math.max(3 * one.grewMb, 600),
      }).toEqual({
        oneMb: one.grewMb,
        eightMb: eight.grewMb,
        bounded: true,
      });
      await e2e.app.get(FilesWorker).tick();
    });
  });
});
