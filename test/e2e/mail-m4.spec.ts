import type { Client } from 'pg';
import { PNG } from 'pngjs';
import { FilesWorker } from '../../src/modules/files/files-worker';
import { MaintenanceWorker } from '../../src/modules/jobs/maintenance-worker';
import { MailWorker } from '../../src/modules/mail/mail-worker';
import { type FakeClamd, startFakeClamd } from '../support/fake-clamd';
import { as, confirmPassword, createActors, type Actors, type SignedIn } from './support/actors';
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
import { linkPath } from './support/links';

/**
 * Templates, email images and the mail log of 0.4.0 (M4-BE-03, M4-BE-05, M4-BE-06; FR-MAIL-01,
 * FR-MAIL-02, FR-SMTP-05, FR-SMTP-06; ST-58, ST-59, ST-60), on a developer's stage against
 * the mail catcher, with a fake ClamAV that finds everything clean.
 */
const MAILPIT_WEB = `http://127.0.0.1:${process.env.CONFERA_MAIL_WEB_PORT ?? '8025'}`;
const MAILPIT_SMTP = Number(process.env.CONFERA_MAIL_SMTP_PORT ?? '1025');

interface MailpitMessage {
  ID: string;
  Subject: string;
}

async function mailsTo(address: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${MAILPIT_WEB}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

async function mailOf(id: string): Promise<{
  HTML: string;
  Text: string;
  Subject: string;
  Inline: { ContentID: string; ContentType: string }[];
  Attachments: unknown[];
}> {
  const response = await fetch(`${MAILPIT_WEB}/api/v1/message/${id}`);
  return (await response.json()) as never;
}

const text = (value: string) => ({ type: 'text', text: value });
const placeholder = (key: string) => ({ type: 'placeholder', key });
const paragraph = (...children: unknown[]) => ({ type: 'paragraph', children });
const doc = (...children: unknown[]) => ({ type: 'doc', children });
const subject = (...children: unknown[]) => ({ type: 'subject', children });

function pngOf(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 30;
    png.data[i + 1] = (i / 4) % 200;
    png.data[i + 2] = 160;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('templates, email images and the mail log (M4-BE-03, 05, 06)', () => {
  jest.setTimeout(300_000);

  let owner: Client;
  let clamd: FakeClamd;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  let worker: MailWorker;
  let form: OpenForm;

  const orgA = () => actors.a.organisation.id;

  const upload = (who: SignedIn | null, bytes: Buffer, name: string) =>
    as(e2e, who, 'post', '/api/v1/mail-images').attach('file', bytes, name);

  async function submitOne(language: 'en' | 'sr'): Promise<{ id: string; email: string }> {
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    await ageTokens(owner, orgA());
    const answers = abstractAnswers();
    const response = await submit(e2e, form.slug, formToken, { language, answers }, { address });
    expect(response.status).toBe(201);
    const [row] = await inOrganisation<{ id: string }>(
      owner,
      orgA(),
      'SELECT id FROM submissions WHERE reference = $1',
      [(response.body as { reference: string }).reference],
    );
    return { id: row?.id ?? '', email: (answers.authors as { email: string }[])[0]?.email ?? '' };
  }

  async function open(id: string): Promise<void> {
    const shown = await as(e2e, admin, 'get', `/api/v1/submissions/${id}`);
    const changed = await as(e2e, admin, 'post', `/api/v1/submissions/${id}/status`).send({
      action: 'open',
      version: (shown.body as { version: number }).version,
    });
    expect(changed.status).toBe(200);
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
    await new Factories(owner).templates(actors.b.organisation.id);
    admin = actors.sessions.adminA;
    await confirmPassword(e2e, admin);
    const server = await as(e2e, admin, 'post', '/api/v1/mail-servers').send({
      name: 'Mailpit',
      host: '127.0.0.1',
      port: MAILPIT_SMTP,
      tlsMode: 'none',
      fromAddress: 'office@a.example.test',
      fromName: 'Ured',
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

  describe('template management (M4-BE-03, FR-MAIL-01, FR-MAIL-02)', () => {
    it('a conference override in Serbian is used by the next email of its type, and removing it falls back', async () => {
      const created = await as(e2e, admin, 'post', '/api/v1/mail-templates').send({
        conferenceId: form.conferenceId,
        type: 'submission_opened',
        language: 'sr',
        subject: subject(text('Posebno za ovu konferenciju: '), placeholder('reference')),
        body: doc(paragraph(text('Đorđe Šćepanović, Čačak, Žabalj: '), placeholder('reference'))),
      });
      expect(created.status).toBe(201);
      const effective = await as(
        e2e,
        admin,
        'get',
        `/api/v1/mail-templates/effective?conferenceId=${form.conferenceId}`,
      );
      const items = (
        effective.body as { items: { type: string; language: string; source: string }[] }
      ).items;
      expect(
        items.find((item) => item.type === 'submission_opened' && item.language === 'sr')?.source,
      ).toBe('conference');
      expect(
        items.find((item) => item.type === 'submission_opened' && item.language === 'en')?.source,
      ).toBe('organisation');
      expect(items).toHaveLength(30);
      const { id, email } = await submitOne('sr');
      await open(id);
      await worker.tick();
      const subjects = (await mailsTo(email)).map((mail) => mail.Subject);
      expect(subjects.some((line) => line.startsWith('Posebno za ovu konferenciju: '))).toBe(true);
      const removed = await as(
        e2e,
        admin,
        'delete',
        `/api/v1/mail-templates/${(created.body as { id: string }).id}`,
      );
      expect(removed.status).toBe(204);
      const after = await as(
        e2e,
        admin,
        'get',
        `/api/v1/mail-templates/effective?conferenceId=${form.conferenceId}`,
      );
      expect(
        (after.body as { items: { type: string; language: string; source: string }[] }).items.find(
          (item) => item.type === 'submission_opened' && item.language === 'sr',
        )?.source,
      ).toBe('organisation');
      // The organisation's own template is never removed: the end of the fallback.
      const [own] = await inOrganisation<{ id: string }>(
        owner,
        orgA(),
        'SELECT id FROM mail_templates WHERE conference_id IS NULL LIMIT 1',
      );
      expect(
        (await as(e2e, admin, 'delete', `/api/v1/mail-templates/${own?.id ?? ''}`)).status,
      ).toBe(409);
    });

    it.each([
      ['markup posted in place of the document', '<p>Hello</p>', 'body', 'not_a_document'],
      [
        'an unknown node',
        doc({ type: 'script', children: [] }),
        'body.children[0]',
        'unknown_node',
      ],
      [
        'an unknown attribute',
        doc(paragraph({ type: 'text', text: 'x', onclick: 'y' })),
        'body.children[0].children[0].onclick',
        'unknown_attribute',
      ],
      [
        'a link with a script scheme',
        doc(paragraph({ type: 'link', href: 'javascript:alert(1)', children: [text('x')] })),
        'body.children[0].children[0].href',
        'link_scheme',
      ],
      [
        'a placeholder outside the catalogue',
        doc(paragraph(placeholder('passwordHash'))),
        'body.children[0].children[0].key',
        'unknown_placeholder',
      ],
      [
        'a placeholder named like a prototype member',
        doc(paragraph(placeholder('__proto__'))),
        'body.children[0].children[0].key',
        'unknown_placeholder',
      ],
      [
        'a remote image',
        doc({ type: 'image', src: 'https://tracker.example.test/p.gif', alt: '' }),
        'body.children[0].src',
        'unknown_attribute',
      ],
    ])('ST-58: refuses %s on save, with its path and code', async (_name, body, path, code) => {
      const [template] = await inOrganisation<{ id: string; version: number }>(
        owner,
        orgA(),
        "SELECT id, version FROM mail_templates WHERE type = 'submission_accepted' AND language = 'en' AND conference_id IS NULL",
      );
      const response = await as(
        e2e,
        admin,
        'put',
        `/api/v1/mail-templates/${template?.id ?? ''}`,
      ).send({
        subject: subject(text('x')),
        body,
        version: template?.version,
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(expect.objectContaining({ errors: [{ path, code }] }));
    });

    it('ST-58, ST-59: a typed brace is text, a hostile string runs nothing in the preview, a body above the limit once rendered is refused', async () => {
      const preview = await as(e2e, admin, 'post', '/api/v1/mail-templates/preview').send({
        type: 'submission_returned',
        language: 'sr',
        subject: subject(text('{{ reference }} '), placeholder('reference')),
        body: doc(
          paragraph(text('{{ title }} <script>alert(1)</script> {% if x %}')),
          paragraph(placeholder('message')),
        ),
      });
      expect(preview.status).toBe(200);
      const shown = preview.body as { subject: string; html: string; text: string };
      expect(shown.subject).toBe('{{ reference }} IT27-0001');
      expect(shown.html).toContain('{{ title }} &lt;script&gt;alert(1)&lt;/script&gt; {% if x %}');
      expect(shown.html).not.toContain('<script');
      // The sample note keeps its two lines.
      expect(shown.html).toContain('<br>');
      const large = await as(e2e, admin, 'post', '/api/v1/mail-templates/preview').send({
        type: 'invitation',
        language: 'en',
        subject: subject(text('x')),
        body: doc(...Array.from({ length: 30 }, () => paragraph(text('&'.repeat(1000))))),
      });
      expect(large.status).toBe(400);
      expect(large.body).toEqual(
        expect.objectContaining({ errors: [{ path: 'body', code: 'too_large' }] }),
      );
    });

    it('asks for the version it changes, and only an admin may change a template', async () => {
      const [template] = await inOrganisation<{ id: string; version: number }>(
        owner,
        orgA(),
        "SELECT id, version FROM mail_templates WHERE type = 'submission_rejected' AND language = 'sr' AND conference_id IS NULL",
      );
      const body = {
        subject: subject(text('Odluka')),
        body: doc(paragraph(text('Ne.'))),
        version: template?.version,
      };
      expect(
        (
          await as(
            e2e,
            actors.sessions.reviewerA,
            'put',
            `/api/v1/mail-templates/${template?.id ?? ''}`,
          ).send(body)
        ).status,
      ).toBe(403);
      expect(
        (await as(e2e, admin, 'put', `/api/v1/mail-templates/${template?.id ?? ''}`).send(body))
          .status,
      ).toBe(200);
      expect(
        (await as(e2e, admin, 'put', `/api/v1/mail-templates/${template?.id ?? ''}`).send(body))
          .status,
      ).toBe(409);
      const audit = await as(e2e, admin, 'get', '/api/v1/audit?action=template.updated');
      expect((audit.body as { total: number }).total).toBeGreaterThanOrEqual(1);
    });
  });

  describe('email images (M4-BE-06, ST-60)', () => {
    let imageId = '';

    it('takes a PNG, re-encodes it, keeps it private, and serves it to an admin only once it is clean', async () => {
      const response = await upload(admin, pngOf(1_000, 250), 'Логотип конференције.png');
      expect(response.status).toBe(201);
      const image = response.body as {
        id: string;
        type: string;
        width: number;
        height: number;
        scanState: string;
        name: string;
      };
      expect(image).toEqual(
        expect.objectContaining({ type: 'png', width: 600, height: 150, scanState: 'pending' }),
      );
      expect(image.name.endsWith('.png')).toBe(true);
      imageId = image.id;
      expect((await as(e2e, admin, 'get', `/api/v1/mail-images/${imageId}`)).status).toBe(409);
      await e2e.app.get(FilesWorker).tick();
      const served = await as(e2e, admin, 'get', `/api/v1/mail-images/${imageId}`);
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(String(served.headers['content-disposition'])).toMatch(/^attachment;/);
      // No route serves an image without a session, nor to another organisation.
      expect((await e2e.admin(`/api/v1/mail-images/${imageId}`)).status).toBe(401);
      expect(
        (await as(e2e, actors.sessions.adminB, 'get', `/api/v1/mail-images/${imageId}`)).status,
      ).toBe(404);
      expect(
        (await as(e2e, actors.sessions.reviewerA, 'get', `/api/v1/mail-images/${imageId}`)).status,
      ).toBe(403);
      const listed = await as(e2e, admin, 'get', '/api/v1/mail-images');
      expect((listed.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
        imageId,
      ]);
    });

    it.each([
      [
        'an SVG',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>'),
        'logo.svg',
        415,
        'image_type_refused',
      ],
      ['a text named .png', Buffer.from('not an image'), 'logo.png', 415, 'image_type_refused'],
      [
        'an image above 5 MB',
        Buffer.concat([pngOf(4, 4), Buffer.alloc(5 * 1024 * 1024)]),
        'big.png',
        413,
        'image_too_large',
      ],
    ])('refuses %s', async (_name, bytes, name, status, code) => {
      const response = await upload(admin, bytes, name);
      expect(response.status).toBe(status);
      expect(response.body).toEqual(expect.objectContaining({ code }));
    });

    it('a template may show only an image of its own organisation', async () => {
      const [template] = await inOrganisation<{ id: string; version: number }>(
        owner,
        actors.b.organisation.id,
        "SELECT id, version FROM mail_templates WHERE type = 'submission_opened' AND language = 'en' AND conference_id IS NULL",
      );
      const response = await as(
        e2e,
        actors.sessions.adminB,
        'put',
        `/api/v1/mail-templates/${template?.id ?? ''}`,
      ).send({
        subject: subject(text('x')),
        body: doc({ type: 'image', fileId: imageId, alt: 'Tuđi logo' }),
        version: template?.version,
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        expect.objectContaining({ errors: [{ path: 'body', code: 'image_unknown' }] }),
      );
    });

    it('sends the image inside the message as an inline part, with no remote reference', async () => {
      const [template] = await inOrganisation<{ id: string; version: number }>(
        owner,
        orgA(),
        "SELECT id, version FROM mail_templates WHERE type = 'submission_opened' AND language = 'en' AND conference_id IS NULL",
      );
      const saved = await as(
        e2e,
        admin,
        'put',
        `/api/v1/mail-templates/${template?.id ?? ''}`,
      ).send({
        subject: subject(text('In processing: '), placeholder('reference')),
        body: doc(
          { type: 'image', fileId: imageId, alt: 'Logo of the conference' },
          paragraph(text('Your submission '), placeholder('reference'), text(' is in processing.')),
        ),
        version: template?.version,
      });
      expect(saved.status).toBe(200);
      const preview = await as(e2e, admin, 'post', '/api/v1/mail-templates/preview').send({
        type: 'submission_opened',
        language: 'en',
        subject: subject(text('x')),
        body: doc({ type: 'image', fileId: imageId, alt: 'Logo' }),
      });
      expect((preview.body as { html: string }).html).toMatch(/<img src="data:image\/png;base64,/);
      const { id, email } = await submitOne('en');
      await open(id);
      await worker.tick();
      const mail = (await mailsTo(email)).find((entry) =>
        entry.Subject.startsWith('In processing'),
      );
      const content = await mailOf(mail?.ID ?? '');
      expect(content.Inline).toEqual([
        expect.objectContaining({ ContentID: `${imageId}@confera`, ContentType: 'image/png' }),
      ]);
      expect(content.HTML).toContain(`src="cid:${imageId}@confera"`);
      expect(content.HTML).not.toMatch(/src="(https?:)?\/\//);
      expect(content.HTML).not.toMatch(/https?:\/\/[^"]*\.(png|gif|jpe?g)/);
      // The log keeps the body and the id of the image, not its bytes.
      const [entry] = await inOrganisation<{ image_ids: string[]; body_html: string }>(
        owner,
        orgA(),
        "SELECT image_ids, body_html FROM mail_log WHERE kind = 'submission_opened' AND recipient = $1",
        [email],
      );
      expect(entry?.image_ids).toEqual([imageId]);
      expect(entry?.body_html).not.toContain('base64');
    });
  });

  describe('the mail log (M4-BE-05, FR-SMTP-05, FR-SMTP-06)', () => {
    it('resends as it was sent, with a fresh link that ends the earlier one', async () => {
      await confirmPassword(e2e, admin);
      const address = 'pozvana.ponovo@a.example.test';
      const invited = await as(e2e, admin, 'post', '/api/v1/users').send({
        email: address,
        displayName: 'Mila Izmišljena',
        role: 'reviewer',
      });
      expect(invited.status).toBe(201);
      await worker.tick();
      const first = await mailOf((await mailsTo(address))[0]?.ID ?? '');
      const firstToken = /invitations\/([A-Za-z0-9_-]{43})/.exec(first.Text)?.[1] ?? '';
      expect((await e2e.admin(linkPath('invitation', firstToken))).status).toBe(200);
      const log = await as(e2e, admin, 'get', '/api/v1/mail-log?kind=invitation');
      const entry = (
        log.body as { items: { id: string; recipient: string; subject: string | null }[] }
      ).items.find((item) => item.recipient === address);
      expect(entry?.subject).toEqual(expect.any(String));
      const resent = await as(e2e, admin, 'post', `/api/v1/mail-log/${entry?.id ?? ''}/resend`);
      expect(resent.status).toBe(200);
      expect(resent.body).toEqual(expect.objectContaining({ resendMode: 'copy' }));
      await worker.tick();
      const mails = await mailsTo(address);
      expect(mails).toHaveLength(2);
      const second = await mailOf(
        mails.find((mail) => mail.ID !== (mails.at(-1)?.ID ?? ''))?.ID ?? '',
      );
      const tokens = await Promise.all(
        mails.map(
          async (mail) =>
            /invitations\/([A-Za-z0-9_-]{43})/.exec((await mailOf(mail.ID)).Text)?.[1] ?? '',
        ),
      );
      const secondToken = tokens.find((token) => token !== firstToken) ?? '';
      expect(secondToken).not.toBe('');
      expect(second.Subject).toBe(first.Subject);
      expect((await e2e.admin(linkPath('invitation', firstToken))).status).toBe(404);
      expect((await e2e.admin(linkPath('invitation', secondToken))).status).toBe(200);
      const listed = await as(
        e2e,
        admin,
        'get',
        `/api/v1/mail-log?messageId=${(resent.body as { messageId: string }).messageId}`,
      );
      expect((listed.body as { items: unknown[] }).items).toEqual([
        expect.objectContaining({ resendOf: expect.any(String), resendMode: 'copy' }),
      ]);
    });

    it('renders again what the log did not keep, and says so; a test message is not resent', async () => {
      const profile = await as(e2e, admin, 'get', '/api/v1/organisation');
      await as(e2e, admin, 'patch', '/api/v1/organisation').send({
        mailLogContent: false,
        version: (profile.body as { version: number }).version,
      });
      const { id } = await submitOne('en');
      await worker.tick();
      const [entry] = await inOrganisation<{ id: string }>(
        owner,
        orgA(),
        "SELECT l.id FROM mail_log l JOIN mail_outbox m ON m.id = l.message_id WHERE m.submission_id = $1 AND l.kind = 'submission_confirmation'",
        [id],
      );
      const resent = await as(e2e, admin, 'post', `/api/v1/mail-log/${entry?.id ?? ''}/resend`);
      expect(resent.body).toEqual(expect.objectContaining({ resendMode: 'rendered_again' }));
      const again = await as(e2e, admin, 'get', '/api/v1/organisation');
      await as(e2e, admin, 'patch', '/api/v1/organisation').send({
        mailLogContent: true,
        version: (again.body as { version: number }).version,
      });
      const [test] = await inOrganisation<{ id: string }>(
        owner,
        orgA(),
        "SELECT l.id FROM mail_log l WHERE l.kind = 'test_message' LIMIT 1",
      );
      if (test !== undefined) {
        expect((await as(e2e, admin, 'post', `/api/v1/mail-log/${test.id}/resend`)).status).toBe(
          409,
        );
      }
    });

    it('keeps 24 months by default, and the retention job removes what is older than the period set', async () => {
      const retention = await as(e2e, admin, 'get', '/api/v1/mail-log/retention');
      expect(retention.body).toEqual(expect.objectContaining({ days: 730 }));
      const set = await as(e2e, admin, 'put', '/api/v1/mail-log/retention').send({
        days: 30,
        version: (retention.body as { version: number }).version,
      });
      expect(set.body).toEqual(expect.objectContaining({ days: 30 }));
      expect(
        (
          await as(e2e, admin, 'put', '/api/v1/mail-log/retention').send({
            days: 5,
            version: (set.body as { version: number }).version,
          })
        ).status,
      ).toBe(400);
      const [old] = await inOrganisation<{ message_id: string }>(
        owner,
        orgA(),
        "SELECT message_id FROM mail_log WHERE result = 'sent' ORDER BY sent_at LIMIT 1",
      );
      await inOrganisation(
        owner,
        orgA(),
        "UPDATE mail_log SET sent_at = now() - interval '40 days' WHERE message_id = $1",
        [old?.message_id],
      );
      await inOrganisation(
        owner,
        orgA(),
        "UPDATE mail_outbox SET created_at = now() - interval '40 days' WHERE id = $1",
        [old?.message_id],
      );
      const before = await inOrganisation<{ n: string }>(
        owner,
        orgA(),
        'SELECT count(*)::text AS n FROM mail_log',
      );
      const report = await e2e.app.get(MaintenanceWorker).run();
      expect(report.logEntries).toBeGreaterThanOrEqual(1);
      expect(report.messages).toBe(1);
      const after = await inOrganisation<{ n: string }>(
        owner,
        orgA(),
        'SELECT count(*)::text AS n FROM mail_log',
      );
      expect(Number(after[0]?.n)).toBe(Number(before[0]?.n) - report.logEntries);
      expect(
        await inOrganisation(owner, orgA(), 'SELECT id FROM mail_outbox WHERE id = $1', [
          old?.message_id,
        ]),
      ).toEqual([]);
      const audit = await as(e2e, admin, 'get', '/api/v1/audit?action=mail_log.purged');
      expect((audit.body as { total: number }).total).toBe(1);
    });
  });
});
