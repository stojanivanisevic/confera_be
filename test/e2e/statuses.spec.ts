import type { Client } from 'pg';
import { MailWorker } from '../../src/modules/mail/mail-worker';
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

/**
 * The status model and its emails (M4-BE-01, M4-BE-02; Spec section 5, FR-SUB-05 to 08,
 * FR-MAIL-03, 05, 07, 08; ST-43, ST-44), on a developer's stage against the mail catcher:
 * every transition of the state table, each with exactly one email in the language of the
 * submission, the preview that is what is sent, the switch per conference, notes,
 * corrections with kept revisions, and the withdrawal.
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

async function mailOf(id: string): Promise<{ HTML: string; Text: string; Subject: string }> {
  const response = await fetch(`${MAILPIT_WEB}/api/v1/message/${id}`);
  return (await response.json()) as { HTML: string; Text: string; Subject: string };
}

interface Detail {
  id: string;
  status: string;
  version: number;
  actions: string[];
  title: string | null;
  statusHistory: {
    status: string;
    fromStatus: string | null;
    transition: number;
    reason: string | null;
    message: string | null;
    email: string;
    emailId: string | null;
  }[];
  emails: { id: string; kind: string; status: string }[];
  notes: { body: string; author: { id: string } }[];
  revisions: { number: number; fields: string[]; before: Record<string, unknown> }[];
  authors: { lastName: string }[];
}

describe('statuses and status emails (M4-BE-01, M4-BE-02)', () => {
  jest.setTimeout(300_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  let worker: MailWorker;
  let form: OpenForm;

  const orgA = () => actors.a.organisation.id;

  async function submitOne(
    language: 'en' | 'sr',
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; email: string }> {
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
    return { id: row?.id ?? '', email: authors[0]?.email ?? '' };
  }

  async function detail(id: string): Promise<Detail> {
    const response = await as(e2e, admin, 'get', `/api/v1/submissions/${id}`);
    expect(response.status).toBe(200);
    return response.body as Detail;
  }

  async function outboxOf(id: string): Promise<{ kind: string; language: string }[]> {
    return inOrganisation(
      owner,
      orgA(),
      'SELECT kind, language FROM mail_outbox WHERE submission_id = $1 ORDER BY created_at',
      [id],
    );
  }

  async function change(id: string, body: Record<string, unknown>) {
    const current = await detail(id);
    return as(e2e, admin, 'post', `/api/v1/submissions/${id}/status`).send({
      version: current.version,
      ...body,
    });
  }

  /** A change with a text for the author: the preview first, then the change with its digest. */
  async function changeWithText(id: string, body: Record<string, unknown>) {
    const preview = await as(e2e, admin, 'post', `/api/v1/submissions/${id}/status/preview`).send(
      body,
    );
    expect(preview.status).toBe(200);
    const digest = (preview.body as { previewDigest: string }).previewDigest;
    return {
      preview: preview.body as Record<string, unknown>,
      response: await change(id, { ...body, previewDigest: digest }),
    };
  }

  beforeAll(async () => {
    owner = await connectAsOwner();
    await fetch(`${MAILPIT_WEB}/api/v1/messages`, { method: 'DELETE' });
    await new Factories(owner).reset();
    e2e = await startE2eApp(e2eLocalEnvironment());
    worker = e2e.app.get(MailWorker);
    actors = await createActors(e2e, owner);
    await new Factories(owner).templates(orgA());
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
    await new Factories(owner).reset();
    await owner.end();
  });

  it('ST-43: reading a submission changes nothing; the move to Open is a POST with the CSRF header', async () => {
    const { id } = await submitOne('en');
    const before = await outboxOf(id);
    for (let n = 0; n < 3; n += 1) {
      expect((await detail(id)).status).toBe('new');
    }
    await as(e2e, admin, 'get', `/api/v1/submissions?q=${id}`).expect(200);
    expect(await outboxOf(id)).toEqual(before);
    const version = (await detail(id)).version;
    // A cross-site request carries the cookie (SameSite=Lax on a navigation), never the header.
    const forged = await e2e
      .http()
      .post(`/api/v1/submissions/${id}/status`)
      .set('Host', 'admin.confera.test')
      .set('Origin', e2e.config.origins.admin)
      .set('Cookie', admin.cookie)
      .send({ action: 'open', version });
    expect(forged.status).toBe(403);
    expect((await detail(id)).status).toBe('new');
    const opened = await change(id, { action: 'open' });
    expect(opened.status).toBe(200);
    expect((opened.body as Detail).status).toBe('open');
    expect(await outboxOf(id)).toEqual([
      { kind: 'submission_confirmation', language: 'en' },
      { kind: 'submission_opened', language: 'en' },
    ]);
  });

  it('walks every transition of the state table, each with exactly one email in the language of the submission (FR-MAIL-05)', async () => {
    const { id, email } = await submitOne('sr');
    const note = 'Skratite apstrakt na 300 reči.\nDodajte ključne reči: učenje, škole.';
    const steps: [Record<string, unknown>, string, string, number][] = [
      [{ action: 'open' }, 'open', 'submission_opened', 2],
      [{ action: 'return', message: note }, 'returned_for_revision', 'submission_returned', 4],
      [{ action: 'resume' }, 'open', 'submission_resumed', 5],
      [{ action: 'accept' }, 'accepted', 'submission_accepted', 6],
      [{ action: 'reopen', reason: 'Pogrešno prihvaćeno' }, 'open', 'submission_reopened', 9],
      [{ action: 'reject' }, 'rejected', 'submission_rejected', 7],
      [{ action: 'reopen', reason: 'Žalba autora' }, 'open', 'submission_reopened', 9],
      [
        { action: 'return', message: 'Još jedna izmena.' },
        'returned_for_revision',
        'submission_returned',
        4,
      ],
      [{ action: 'accept' }, 'accepted', 'submission_accepted', 6],
      [{ action: 'withdraw', reason: 'Autor odustao' }, 'withdrawn', 'submission_withdrawn', 8],
    ];
    for (const [body, to, kind, row] of steps) {
      // Every change but open is sent with the digest of its preview (SEC-M4-05).
      const response =
        body.action === 'open' ? await change(id, body) : (await changeWithText(id, body)).response;
      expect({ body, status: response.status }).toEqual({ body, status: 200 });
      const shown = response.body as Detail;
      expect(shown.status).toBe(to);
      const last = shown.statusHistory.at(-1);
      expect(last).toEqual(
        expect.objectContaining({ status: to, transition: row, email: 'queued' }),
      );
      expect(shown.emails.at(-1)).toEqual(expect.objectContaining({ kind }));
    }
    const kinds = (await outboxOf(id)).map((row) => `${row.kind}:${row.language}`);
    expect(kinds).toEqual([
      'submission_confirmation:sr',
      ...steps.map(([, , kind]) => `${kind}:sr`),
    ]);
    await worker.tick();
    const received = await mailsTo(email);
    expect(received).toHaveLength(steps.length + 1);
    // The "returned for revision" email holds the note word for word, its lines kept.
    const texts = await Promise.all(received.map(async (mail) => (await mailOf(mail.ID)).Text));
    expect(texts.filter((text) => text.replace(/\r\n/g, '\n').includes(note))).toHaveLength(1);
    // The internal reason is never sent.
    for (const mail of received) {
      expect((await mailOf(mail.ID)).Text).not.toContain('Autor odustao');
    }
    // The withdrawn submission can do nothing more, and nothing more is sent.
    expect((await detail(id)).actions).toEqual([]);
  });

  it('refuses every change the table does not have, and a repeated request sends no second email', async () => {
    const { id } = await submitOne('en');
    for (const action of ['return', 'resume', 'accept', 'reject', 'reopen']) {
      const refused = await change(id, { action, message: 'x', reason: 'y' });
      expect({ action, status: refused.status }).toEqual({ action, status: expect.any(Number) });
      expect([400, 409]).toContain(refused.status);
    }
    const accept = await change(id, { action: 'accept' });
    expect(accept.status).toBe(409);
    expect(accept.body).toEqual(expect.objectContaining({ code: 'transition_refused' }));
    const version = (await detail(id)).version;
    const first = await as(e2e, admin, 'post', `/api/v1/submissions/${id}/status`).send({
      action: 'open',
      version,
    });
    const second = await as(e2e, admin, 'post', `/api/v1/submissions/${id}/status`).send({
      action: 'open',
      version,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect((await outboxOf(id)).filter((row) => row.kind === 'submission_opened')).toHaveLength(1);
    // Two admins at once, each with the preview they saw: one wins, the other is told.
    const current = (await detail(id)).version;
    const digestOf = async (action: string) =>
      (
        (await as(e2e, admin, 'post', `/api/v1/submissions/${id}/status/preview`).send({ action }))
          .body as { previewDigest: string }
      ).previewDigest;
    const [acceptDigest, rejectDigest] = [await digestOf('accept'), await digestOf('reject')];
    const [a, b] = await Promise.all([
      as(e2e, admin, 'post', `/api/v1/submissions/${id}/status`).send({
        action: 'accept',
        version: current,
        previewDigest: acceptDigest,
      }),
      as(e2e, admin, 'post', `/api/v1/submissions/${id}/status`).send({
        action: 'reject',
        version: current,
        previewDigest: rejectDigest,
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const sent = (await outboxOf(id)).filter((row) =>
      ['submission_accepted', 'submission_rejected'].includes(row.kind),
    );
    expect(sent).toHaveLength(1);
  });

  it('SEC-M4-05: every change whose email is on needs the digest of its preview, with or without a text; open does not', async () => {
    const { id } = await submitOne('en');
    expect((await change(id, { action: 'open' })).status).toBe(200);
    const blind = await change(id, { action: 'accept' });
    expect(blind.status).toBe(400);
    expect(blind.body).toEqual(
      expect.objectContaining({ errors: [{ path: 'previewDigest', code: 'required' }] }),
    );
    expect((await detail(id)).status).toBe('open');
    expect((await outboxOf(id)).map((row) => row.kind)).not.toContain('submission_accepted');
    const { response } = await changeWithText(id, { action: 'accept' });
    expect(response.status).toBe(200);
    expect((await outboxOf(id)).map((row) => row.kind)).toContain('submission_accepted');
  });

  it('FR-MAIL-08: the email with a text is shown first and sent exactly as shown; a cancelled one changes nothing', async () => {
    const { id, email } = await submitOne('en');
    await change(id, { action: 'open' });
    const note = 'Please add the keywords.';
    // Without the preview's digest a text for the author is not sent.
    const blind = await change(id, { action: 'return', message: note });
    expect(blind.status).toBe(400);
    expect((await detail(id)).status).toBe('open');
    const preview = await as(e2e, admin, 'post', `/api/v1/submissions/${id}/status/preview`).send({
      action: 'return',
      message: note,
    });
    expect(preview.body).toEqual(
      expect.objectContaining({
        sends: true,
        to: email,
        language: 'en',
        previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    // Cancelling is not sending the change: the preview changed nothing.
    expect((await detail(id)).status).toBe('open');
    expect((await outboxOf(id)).filter((row) => row.kind === 'submission_returned')).toEqual([]);
    // The template changes between the preview and the confirmation: refused, nothing changes.
    const [template] = await inOrganisation<{ id: string; body: unknown }>(
      owner,
      orgA(),
      "SELECT id, body FROM mail_templates WHERE type = 'submission_returned' AND language = 'en' AND conference_id IS NULL",
    );
    await inOrganisation(
      owner,
      orgA(),
      'UPDATE mail_templates SET body = jsonb_set(body, \'{children,0}\', \'{"type":"paragraph","children":[{"type":"text","text":"Changed meanwhile."}]}\') WHERE id = $1',
      [template?.id],
    );
    const digest = (preview.body as { previewDigest: string }).previewDigest;
    const outdated = await change(id, { action: 'return', message: note, previewDigest: digest });
    expect(outdated.status).toBe(409);
    expect(outdated.body).toEqual(expect.objectContaining({ code: 'preview_outdated' }));
    expect((await detail(id)).status).toBe('open');
    await inOrganisation(owner, orgA(), 'UPDATE mail_templates SET body = $2 WHERE id = $1', [
      template?.id,
      JSON.stringify(template?.body),
    ]);
    const { preview: shown, response } = await changeWithText(id, {
      action: 'return',
      message: note,
    });
    expect(response.status).toBe(200);
    await worker.tick();
    const mail = (await mailsTo(email)).find((entry) => entry.Subject.includes('needs changes'));
    const content = await mailOf(mail?.ID ?? '');
    expect(content.Subject).toBe(shown.subject);
    expect(content.Text.replace(/\r\n/g, '\n').trim()).toBe(String(shown.text).trim());
  });

  it('ST-44: a hostile title and a hostile note arrive as text', async () => {
    const { id, email } = await submitOne('en');
    // Planted past the form's rules, as a correction or another path might.
    await inOrganisation(owner, orgA(), 'UPDATE submissions SET title = $2 WHERE id = $1', [
      id,
      '<script>alert(1)</script> Učenje "<b>x</b>"',
    ]);
    await change(id, { action: 'open' });
    const note = '<img src=x onerror=alert(1)> & <a href="https://evil.example.test">click</a>';
    await changeWithText(id, { action: 'return', message: note });
    await worker.tick();
    for (const mail of await mailsTo(email)) {
      const content = await mailOf(mail.ID);
      expect(content.HTML).not.toMatch(/<script|<img|<a href="https:\/\/evil/i);
    }
    const returned = (await mailsTo(email)).find((mail) => mail.Subject.includes('needs changes'));
    const content = await mailOf(returned?.ID ?? '');
    expect(content.HTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(content.Text).toContain(note);
  });

  it('ST-44, SEC-M4-03: a bare domain as the name of an author never reaches a status email', async () => {
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    await ageTokens(owner, orgA());
    const email = `evil.${String(Date.now())}@autori.example.test`;
    const answers = abstractAnswers({
      authors: [
        {
          firstName: 'evil.com',
          lastName: 'Petrović',
          institution: 'Univerzitet u Izmišljenom Gradu',
          email,
          phone: '+381 11 123 4567',
        },
      ],
    });
    const response = await submit(
      e2e,
      form.slug,
      formToken,
      { language: 'en', answers },
      { address },
    );
    expect(response.status).toBe(201);
    const [row] = await inOrganisation<{ id: string }>(
      owner,
      orgA(),
      'SELECT id FROM submissions WHERE reference = $1',
      [(response.body as { reference: string }).reference],
    );
    const id = row?.id ?? '';
    // Opening sends the submission_opened mail with no decision of the office (UX4-08).
    expect((await change(id, { action: 'open' })).status).toBe(200);
    await worker.tick();
    const opened = (await mailsTo(email)).find((mail) => mail.Subject.includes('being processed'));
    expect(opened).toBeDefined();
    const content = await mailOf(opened?.ID ?? '');
    expect(content.Text).toContain('Dear ,');
    expect(content.Text).not.toContain('evil.com');
    expect(content.HTML).not.toContain('evil.com');
    // Other shapes, planted past the form: none reaches the preview of a status email.
    for (const name of [
      'Ana paypal-verify.com',
      'Ana https://phish.example.test/x',
      'Ana x.com:8080/a',
      'Ana PRIMER.SRB',
      'Ana ana@napadac.example.test',
    ]) {
      await inOrganisation(
        owner,
        orgA(),
        'UPDATE submissions SET first_author_name = $2 WHERE id = $1',
        [id, name],
      );
      const preview = await as(e2e, admin, 'post', `/api/v1/submissions/${id}/status/preview`).send(
        {
          action: 'accept',
        },
      );
      expect(preview.status).toBe(200);
      const shown = preview.body as { html: string; text: string; subject: string };
      expect({ name, text: shown.text.includes('Ana ') }).toEqual({ name, text: false });
      expect(shown.html).not.toMatch(/paypal|phish|x\.com|primer\.srb|napadac/i);
    }
  });

  it('FR-MAIL-07: a status email switched off for a conference sends nothing there and still does elsewhere', async () => {
    const other = await openForm(e2e, admin);
    const switches = await as(
      e2e,
      admin,
      'get',
      `/api/v1/conferences/${form.conferenceId}/status-emails`,
    );
    expect(
      (switches.body as { types: { enabled: boolean }[] }).types.every((type) => type.enabled),
    ).toBe(true);
    const off = await as(
      e2e,
      admin,
      'put',
      `/api/v1/conferences/${form.conferenceId}/status-emails`,
    ).send({
      types: [{ type: 'submission_opened', enabled: false }],
      version: (switches.body as { version: number }).version,
    });
    expect(off.status).toBe(200);
    const { id } = await submitOne('en');
    const opened = (await change(id, { action: 'open' })).body as Detail;
    expect(opened.statusHistory.at(-1)).toEqual(
      expect.objectContaining({ status: 'open', email: 'template_off', emailId: null }),
    );
    expect((await outboxOf(id)).map((row) => row.kind)).toEqual(['submission_confirmation']);
    const preview = await as(e2e, admin, 'post', `/api/v1/submissions/${id}/status/preview`).send({
      action: 'accept',
    });
    expect(preview.body).toEqual(expect.objectContaining({ sends: true }));
    // The other conference still sends it.
    const saved = form;
    form = other;
    const elsewhere = await submitOne('en');
    form = saved;
    await change(elsewhere.id, { action: 'open' });
    expect((await outboxOf(elsewhere.id)).map((row) => row.kind)).toEqual([
      'submission_confirmation',
      'submission_opened',
    ]);
    const on = await as(
      e2e,
      admin,
      'put',
      `/api/v1/conferences/${form.conferenceId}/status-emails`,
    ).send({
      types: [{ type: 'submission_opened', enabled: true }],
      version: (off.body as { version: number }).version,
    });
    expect(on.status).toBe(200);
  });

  it('keeps notes for the admins only, and corrections with the old values (FR-SUB-06, FR-SUB-07)', async () => {
    const { id } = await submitOne('sr');
    const note = await as(e2e, admin, 'post', `/api/v1/submissions/${id}/notes`).send({
      body: 'Proveriti afilijaciju.\nPozvati autora.',
    });
    expect(note.status).toBe(201);
    const reviewer = await as(
      e2e,
      actors.sessions.reviewerA,
      'post',
      `/api/v1/submissions/${id}/notes`,
    ).send({ body: 'x' });
    expect(reviewer.status).toBe(403);
    const before = await detail(id);
    expect(before.notes).toEqual([
      expect.objectContaining({
        body: 'Proveriti afilijaciju.\nPozvati autora.',
        author: expect.objectContaining({ id: actors.a.admin.id }),
      }),
    ]);
    const answers = abstractAnswers({ title: 'Nov naslov o učenju' });
    const edited = await as(e2e, admin, 'put', `/api/v1/submissions/${id}`).send({
      version: before.version,
      answers: {
        title: 'Nov naslov o učenju',
        authors: [
          ...(answers.authors as object[]),
          {
            firstName: 'Đorđe',
            lastName: 'Šćepanović',
            institution: 'Institut u Žablju',
            email: 'djordje@autori.example.test',
          },
        ],
      },
    });
    expect(edited.status).toBe(200);
    const after = edited.body as Detail;
    expect(after.title).toBe('Nov naslov o učenju');
    expect(after.authors.map((author) => author.lastName)).toEqual(['Đorđević', 'Šćepanović']);
    expect(after.revisions).toEqual([
      expect.objectContaining({
        number: 1,
        fields: ['authors', 'title'],
        before: expect.objectContaining({ title: 'Učenje na daljinu u malim školama' }) as unknown,
      }),
    ]);
    // A correction sends no email; the search finds the new name.
    expect((await outboxOf(id)).map((row) => row.kind)).toEqual(['submission_confirmation']);
    const found = await as(e2e, admin, 'get', '/api/v1/submissions?q=scepanovic%20zablju');
    expect((found.body as { items: { id: string }[] }).items.map((item) => item.id)).toContain(id);
    // A stale version, and a rule of the form, are refused.
    const stale = await as(e2e, admin, 'put', `/api/v1/submissions/${id}`).send({
      version: before.version,
      answers: { title: 'x' },
    });
    expect(stale.status).toBe(409);
    const broken = await as(e2e, admin, 'put', `/api/v1/submissions/${id}`).send({
      version: after.version,
      answers: { authors: [] },
    });
    expect(broken.status).toBe(400);
  });

  it('FR-SUB-08: a withdrawn submission keeps its data, leaves the default view and is found with the filter', async () => {
    const { id } = await submitOne('en', { title: 'Povučeni rad o zadrugama' });
    await changeWithText(id, {
      action: 'withdraw',
      reason: 'Dupla prijava',
      message: 'Your submission was a duplicate.',
    });
    const shown = await detail(id);
    expect(shown.status).toBe('withdrawn');
    expect(shown.title).toBe('Povučeni rad o zadrugama');
    const listed = await as(e2e, admin, 'get', '/api/v1/submissions?q=zadrugama');
    expect((listed.body as { total: number }).total).toBe(0);
    const filtered = await as(
      e2e,
      admin,
      'get',
      '/api/v1/submissions?q=zadrugama&status=withdrawn',
    );
    expect((filtered.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      id,
    ]);
    const edit = await as(e2e, admin, 'put', `/api/v1/submissions/${id}`).send({
      version: shown.version,
      answers: { title: 'x' },
    });
    expect(edit.status).toBe(409);
  });

  it('the audit log has every change of status with who and when (FR-SUB-05)', async () => {
    const audit = await as(e2e, admin, 'get', '/api/v1/audit?action=submission.status_changed');
    expect((audit.body as { total: number }).total).toBeGreaterThanOrEqual(10);
    const rows = await inOrganisation<{ changes: Record<string, unknown>; actor_user_id: string }>(
      owner,
      orgA(),
      "SELECT changes, actor_user_id FROM audit_entries WHERE action = 'submission.status_changed' LIMIT 1",
    );
    expect(rows[0]?.actor_user_id).toBe(actors.a.admin.id);
    expect(rows[0]?.changes).toEqual({
      status: expect.objectContaining({ new: expect.any(String) }),
    });
  });
});
