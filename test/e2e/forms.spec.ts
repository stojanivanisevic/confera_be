import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { MailWorker } from '../../src/modules/mail/mail-worker';
import { solveProofOfWork } from '../../src/modules/forms/proof-of-work';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import { ADMIN_HOST, type E2eApp, e2eLocalEnvironment, startE2eApp } from './support/e2e-app';
import { connect, connectAsOwner, e2eDatabase } from './support/e2e-database';
import { Factories } from './support/factories';
import {
  abstractAnswers,
  ageTokens,
  freshAddress,
  inOrganisation,
  openForm,
  page,
  submit,
  tokenFor,
} from './support/forms';

/**
 * Forms and intake end to end (M3-BE-01, 02, 03, 05, 06, 07; FR-FORM-01, 02, 07, 09, 11 to
 * 15, FR-SUB-01, 02, 04, FR-DL-01 to 03, FR-MAIL-04; ST-31, ST-34, ST-35, ST-41), on a
 * developer stage so that the confirmation travels through Mailpit.
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

async function mailText(id: string): Promise<{ HTML: string; Text: string; Subject: string }> {
  const response = await fetch(`${MAILPIT_WEB}/api/v1/message/${id}`);
  return (await response.json()) as { HTML: string; Text: string; Subject: string };
}

describe('forms and intake (M3)', () => {
  jest.setTimeout(300_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  let adminB: SignedIn;
  let worker: MailWorker;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp(e2eLocalEnvironment());
    worker = e2e.app.get(MailWorker);
    actors = await createActors(e2e, owner);
    await new Factories(owner).templates(actors.a.organisation.id);
    admin = await signIn(e2e, actors.a.admin);
    adminB = await signIn(e2e, actors.b.admin);
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
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  const orgA = () => actors.a.organisation.id;

  describe('the admin configures and publishes a form (M3-BE-01, FR-FORM-02)', () => {
    it('creates the abstract form of a conference with the catalogue defaults, unpublished', async () => {
      const created = await as(e2e, admin, 'post', '/api/v1/conferences').send({
        name: 'Konfiguracija (izmišljeno)',
        code: 'KF',
        editionYear: 2031,
      });
      const conference = created.body as { id: string };
      const form = await as(e2e, admin, 'post', `/api/v1/conferences/${conference.id}/forms`).send({
        type: 'abstract',
      });
      expect(form.status).toBe(201);
      const body = form.body as {
        id: string;
        slug: string;
        currentVersion: unknown;
        state: string;
        closedReason: string;
        draftDefinition: { sections: { key: string; repeat: { max: number } | null }[] };
        version: number;
      };
      expect(body.slug).toMatch(/^[a-z0-9]{16}$/);
      expect(body.currentVersion).toBeNull();
      expect(body).toEqual(
        expect.objectContaining({ state: 'closed', closedReason: 'not_published' }),
      );
      expect(body.draftDefinition.sections.find((s) => s.key === 'authors')?.repeat?.max).toBe(10);
      // One form of a type per conference.
      const again = await as(e2e, admin, 'post', `/api/v1/conferences/${conference.id}/forms`).send(
        {
          type: 'abstract',
        },
      );
      expect(again.status).toBe(409);
      expect(again.body).toEqual(expect.objectContaining({ code: 'form_exists' }));
      // Not public before it is published.
      expect((await page(e2e, 'get', `/public/v1/forms/${body.slug}`)).status).toBe(404);

      // A draft beyond the catalogue is refused field by field.
      const refused = await as(e2e, admin, 'put', `/api/v1/forms/${body.id}/draft`).send({
        configuration: { maxAuthors: 51, fields: { title: { enabled: false }, isAdmin: {} } },
        version: body.version,
      });
      expect(refused.status).toBe(400);
      expect((refused.body as { errors: { path: string }[] }).errors.map((e) => e.path)).toEqual(
        expect.arrayContaining(['configuration.maxAuthors']),
      );

      const saved = await as(e2e, admin, 'put', `/api/v1/forms/${body.id}/draft`).send({
        configuration: { maxAuthors: 6, fields: { abstract: { maxWords: 250 } } },
        version: body.version,
      });
      expect(saved.status).toBe(200);
      const stale = await as(e2e, admin, 'put', `/api/v1/forms/${body.id}/draft`).send({
        configuration: {},
        version: body.version,
      });
      expect(stale.status).toBe(409);
      const draft = saved.body as { version: number };
      const published = await as(e2e, admin, 'post', `/api/v1/forms/${body.id}/publish`).send({
        version: draft.version,
      });
      expect(published.status).toBe(201);
      expect(published.body).toEqual(
        expect.objectContaining({ currentVersion: expect.objectContaining({ number: 1 }) }),
      );
      const version = await as(e2e, admin, 'get', `/api/v1/forms/${body.id}/versions/1`);
      expect(version.status).toBe(200);
      expect(JSON.stringify(version.body)).toContain('"maxWords":250');
      // The other organisation finds nothing of it.
      expect((await as(e2e, adminB, 'get', `/api/v1/forms/${body.id}`)).status).toBe(404);
      const list = await as(e2e, adminB, 'get', '/api/v1/forms');
      expect((list.body as { items: unknown[] }).items).toEqual([]);
    });

    it('a copy of a conference takes its forms as unpublished drafts, each at an address of its own (FR-CONF-03)', async () => {
      const source = await openForm(e2e, admin, { configuration: { maxAuthors: 4 } });
      const copied = await as(
        e2e,
        admin,
        'post',
        `/api/v1/conferences/${source.conferenceId}/copy`,
      ).send({
        name: 'Kopija (izmišljeno)',
        editionYear: 2100,
      });
      expect(copied.status).toBe(201);
      const list = await as(
        e2e,
        admin,
        'get',
        `/api/v1/forms?conferenceId=${(copied.body as { id: string }).id}`,
      );
      const items = (
        list.body as { items: { id: string; slug: string; currentVersionNumber: number | null }[] }
      ).items;
      expect(items).toHaveLength(1);
      expect(items[0]?.slug).not.toBe(source.slug);
      expect(items[0]?.currentVersionNumber).toBeNull();
      const form = await as(e2e, admin, 'get', `/api/v1/forms/${items[0]?.id ?? ''}`);
      expect((form.body as { configuration: unknown }).configuration).toEqual({ maxAuthors: 4 });
      expect(
        (await as(e2e, admin, 'get', `/api/v1/forms/${source.formId}/versions/99999999999`)).status,
      ).toBe(404);
    });

    it('a published version cannot be changed, not even by a statement of the application role', async () => {
      const app = await connect(e2eDatabase.applicationUrl);
      try {
        await app.query('BEGIN');
        await app.query("SELECT set_config('app.org_id', $1, true)", [orgA()]);
        await expect(app.query("UPDATE form_versions SET definition = '{}'")).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await app.query('ROLLBACK');
        await app.end();
      }
    });
  });

  describe('the public form (ADR-08, FR-FORM-07)', () => {
    it('shows the published definition, the deadline and the consent links (D6)', async () => {
      const form = await openForm(e2e, admin, {
        deadline: '2099-06-30',
        publicationTermsUrl: 'https://www.konferencija.example.test/uslovi',
      });
      const response = await page(e2e, 'get', `/public/v1/forms/${form.slug}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          slug: form.slug,
          state: 'open',
          deadline: '2099-06-30',
          closesAt: '2099-06-30T22:00:00.000Z',
          consentLinks: { terms: 'https://www.konferencija.example.test/uslovi', privacy: null },
          versionNumber: 1,
        }),
      );
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      // Under the admin host name the public API does not exist (ADR-02).
      const wrongHost = await e2e
        .http()
        .get(`/public/v1/forms/${form.slug}`)
        .set('Host', ADMIN_HOST);
      expect(wrongHost.status).toBe(404);
      // The frame sites, checked again (ADR-07).
      const sites = await page(e2e, 'get', `/public/v1/forms/${form.slug}/frame-sites`);
      expect(sites.body).toEqual({ sites: ['https://www.konferencija.example.test'] });
      expect((await page(e2e, 'get', '/public/v1/forms/aaaaaaaaaaaaaaaa')).status).toBe(404);
      expect((await page(e2e, 'get', '/public/v1/forms/..%2F..%2Fetc')).status).toBe(404);
    });

    it('ST-31: a request of another site, an HTML form and a no-cors fetch are refused and store nothing', async () => {
      const form = await openForm(e2e, admin);
      const address = freshAddress();
      const { formToken } = await tokenFor(e2e, form.slug, address);
      await ageTokens(owner, orgA());
      const body = JSON.stringify({ language: 'en', answers: abstractAnswers() });
      const path = `/public/v1/forms/${form.slug}/submissions`;
      const harness = 'https://www.konferencija.example.test';
      const attempts = [
        // Another site's page, as JSON.
        page(e2e, 'post', path, address)
          .set('Origin', harness)
          .set('Content-Type', 'application/json'),
        // An HTML form: plain text and url-encoded.
        page(e2e, 'post', path, address).set('Origin', harness).set('Content-Type', 'text/plain'),
        page(e2e, 'post', path, address).set('Content-Type', 'text/plain'),
        page(e2e, 'post', path, address).set('Content-Type', 'application/x-www-form-urlencoded'),
        // A fetch from another site that claims the Origin but not the fetch site.
        page(e2e, 'post', path, address)
          .set('Sec-Fetch-Site', 'cross-site')
          .set('Content-Type', 'application/json'),
        // No Origin at all.
        e2e
          .http()
          .post(path)
          .set('Host', 'forms.confera.test')
          .set('Content-Type', 'application/json'),
      ];
      for (const attempt of attempts) {
        const response = await attempt
          .set('X-Form-Token', formToken)
          .set('Idempotency-Key', randomUUID())
          .send(body);
        expect([403, 415]).toContain(response.status);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
      // A preflight gets no grant.
      const preflight = await page(e2e, 'get', path)
        .set('Access-Control-Request-Method', 'POST')
        .set('Origin', harness);
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      const options = await e2e
        .http()
        .options(path)
        .set('Host', 'forms.confera.test')
        .set('Origin', harness);
      expect(options.status).toBe(405);
      // An admin's session cookie on /public is not read: the request is anonymous.
      const withCookie = await page(e2e, 'post', `/public/v1/forms/${form.slug}/tokens`, address)
        .set('Cookie', admin.cookie)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(withCookie.status).toBe(201);
      const stored = await inOrganisation(
        owner,
        orgA(),
        'SELECT id FROM submissions WHERE form_id = $1',
        [form.formId],
      );
      expect(stored).toEqual([]);
    });
  });

  describe('a submission (FR-FORM-14, FR-SUB-01, FR-FORM-15, FR-MAIL-04, ST-35)', () => {
    it('is stored complete once, with one confirmation, in the language of the form', async () => {
      const form = await openForm(e2e, admin);
      const address = freshAddress();
      const answers = abstractAnswers({
        title: '<b>Učenje</b> & "nastava" u Šapcu',
        authors: [
          {
            firstName: 'Živana',
            lastName: 'Đorđević',
            institution: 'Univerzitet u Izmišljenom Gradu',
            email: `zivana.${randomUUID().slice(0, 8)}@autori.example.test`,
            orcid: '0000-0002-1825-0097',
          },
          {
            firstName: 'Časlav',
            lastName: 'Šćepanović',
            institution: 'Institut',
            email: 'caslav@autori.example.test',
          },
          {
            firstName: 'Ana',
            lastName: 'Čolić',
            institution: 'Institut',
            email: 'ana@autori.example.test',
          },
        ],
      });
      const recipient = (answers.authors as { email: string }[])[0]?.email ?? '';
      const { formToken } = await tokenFor(e2e, form.slug, address);
      await ageTokens(owner, orgA());
      const key = randomUUID();
      const body = { language: 'sr', answers };
      const first = await submit(e2e, form.slug, formToken, body, { address, key });
      expect(first.status).toBe(201);
      const result = first.body as { reference: string; language: string };
      expect(result.reference).toBe(`${form.code}${String(form.editionYear % 100)}-0001`);
      expect(result.language).toBe('sr');
      // A double click and a repeat after a reload: the first result, nothing more.
      const [again, reloaded] = await Promise.all([
        submit(e2e, form.slug, formToken, body, { address, key }),
        (async () => {
          const second = await tokenFor(e2e, form.slug, address);
          await ageTokens(owner, orgA());
          return submit(e2e, form.slug, second.formToken, body, { address, key });
        })(),
      ]);
      expect(again.status).toBe(201);
      expect(again.body).toEqual(first.body);
      expect(reloaded.body).toEqual(first.body);
      // The same key with other answers is refused.
      const other = await submit(
        e2e,
        form.slug,
        formToken,
        { language: 'sr', answers: abstractAnswers() },
        { address, key },
      );
      expect(other.status).toBe(409);
      expect(other.body).toEqual(expect.objectContaining({ code: 'idempotency_key_reused' }));
      // The token worked once (ST-34).
      const reused = await submit(e2e, form.slug, formToken, body, { address });
      expect(reused.status).toBe(409);
      expect(reused.body).toEqual(expect.objectContaining({ code: 'form_token_used' }));

      const rows = await inOrganisation<{
        id: string;
        author_count: number;
        language: string;
        consent_text: string;
      }>(
        owner,
        orgA(),
        'SELECT id, author_count, language, consent_text FROM submissions WHERE form_id = $1',
        [form.formId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ author_count: 3, language: 'sr' }));
      expect(rows[0]?.consent_text).toContain('Saglasan/na sam');
      const outbox = await inOrganisation(
        owner,
        orgA(),
        "SELECT id FROM mail_outbox WHERE kind = 'submission_confirmation' AND submission_id = $1",
        [rows[0]?.id],
      );
      expect(outbox).toHaveLength(1);

      // The office sees it (FR-SUB-02, FR-SUB-04).
      const list = await as(
        e2e,
        admin,
        'get',
        `/api/v1/submissions?conferenceId=${form.conferenceId}`,
      );
      expect(list.status).toBe(200);
      expect(list.body).toEqual(
        expect.objectContaining({
          total: 1,
          items: [
            expect.objectContaining({
              reference: result.reference,
              firstAuthor: 'Živana Đorđević',
              institution: 'Univerzitet u Izmišljenom Gradu',
              participationType: 'with_paper',
              authorCount: 3,
            }),
          ],
        }),
      );
      const detail = await as(e2e, admin, 'get', `/api/v1/submissions/${rows[0]?.id ?? ''}`);
      expect(detail.status).toBe(200);
      const shown = detail.body as {
        authors: { position: number; lastName: string; isCorresponding: boolean }[];
        statusHistory: { status: string }[];
        consent: { text: string; version: string };
        emails: { kind: string; status: string }[];
        answers: Record<string, unknown>;
      };
      expect(shown.authors.map((a) => [a.position, a.lastName, a.isCorresponding])).toEqual([
        [1, 'Đorđević', true],
        [2, 'Šćepanović', false],
        [3, 'Čolić', false],
      ]);
      expect(shown.statusHistory.map((s) => s.status)).toEqual(['new']);
      expect(shown.consent.version).toMatch(/^[0-9a-f]{64}$/);
      expect(shown.emails).toEqual([
        expect.objectContaining({ kind: 'submission_confirmation', status: 'queued' }),
      ]);
      expect(shown.answers.attendance).toBe('in_person');
      // The other organisation sees none of it.
      expect(
        (await as(e2e, adminB, 'get', `/api/v1/submissions/${rows[0]?.id ?? ''}`)).status,
      ).toBe(404);
      expect((await as(e2e, adminB, 'get', '/api/v1/submissions')).body).toEqual(
        expect.objectContaining({ total: 0, items: [] }),
      );

      // The confirmation: Serbian, fixed text, the reference and the title only, as text.
      await worker.tick();
      const mails = await mailsTo(recipient);
      expect(mails).toHaveLength(1);
      const mail = await mailText(mails[0]?.ID ?? '');
      expect(mail.Subject).toBe(
        // The conference name stays in the nominative (M3-ISS-13): never declined in a sentence.
        `Vaša prijava ${result.reference} – konferencija: Probna konferencija ${String(form.editionYear)} (izmišljeno)`,
      );
      expect(mail.Text).toContain('Naslov: <b>Učenje</b> & "nastava" u Šapcu');
      expect(mail.HTML).toContain('&lt;b&gt;Učenje&lt;/b&gt;');
      expect(mail.HTML).not.toMatch(/<a\s/i);
      expect(mail.Text).not.toContain('Živana');
      expect(mail.Text).not.toContain('Kratak apstrakt');
    });

    it('Q3-01: a refused token is renewed and the submit that follows at once is stored, not taken for a script', async () => {
      const form = await openForm(e2e, admin);
      const address = freshAddress();
      const first = await tokenFor(e2e, form.slug, address);
      await ageTokens(owner, orgA());
      // The page sat open past the token's life.
      await inOrganisation(
        owner,
        orgA(),
        "UPDATE form_tokens SET expires_at = now() - interval '1 second'",
      );
      const refused = await submit(
        e2e,
        form.slug,
        first.formToken,
        { language: 'en', answers: abstractAnswers() },
        { address },
      );
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual(expect.objectContaining({ code: 'form_token_invalid' }));
      const renewed = await page(e2e, 'post', `/public/v1/forms/${form.slug}/tokens`, address)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ previousFormToken: first.formToken }));
      expect(renewed.status).toBe(201);
      const next = renewed.body as { formToken: string };
      // At once, without a moment's wait: a real submission.
      const stored = await submit(
        e2e,
        form.slug,
        next.formToken,
        { language: 'en', answers: abstractAnswers() },
        { address },
      );
      expect(stored.status).toBe(201);
      const rows = await inOrganisation(
        owner,
        orgA(),
        'SELECT id FROM submissions WHERE form_id = $1',
        [form.formId],
      );
      expect(rows).toHaveLength(1);
      // A token of another form renews nothing: a submit at once is still a script.
      const other = await openForm(e2e, admin);
      const foreign = await tokenFor(e2e, other.slug, address);
      const unrelated = await page(e2e, 'post', `/public/v1/forms/${form.slug}/tokens`, address)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ previousFormToken: foreign.formToken }));
      const quick = await submit(
        e2e,
        form.slug,
        (unrelated.body as { formToken: string }).formToken,
        { language: 'en', answers: abstractAnswers() },
        { address },
      );
      expect(quick.status).toBe(201);
      expect(
        await inOrganisation(owner, orgA(), 'SELECT id FROM submissions WHERE form_id = $1', [
          form.formId,
        ]),
      ).toHaveLength(1);
    });

    it('SEC-M3-04: a token used by a submission or by a fake success renews nothing: the next chain is its own', async () => {
      const form = await openForm(e2e, admin);
      const storedOf = async () =>
        (
          await inOrganisation(owner, orgA(), 'SELECT id FROM submissions WHERE form_id = $1', [
            form.formId,
          ])
        ).length;
      const renew = async (previous: string, address: string) => {
        const response = await page(e2e, 'post', `/public/v1/forms/${form.slug}/tokens`, address)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ previousFormToken: previous }));
        expect(response.status).toBe(201);
        return (response.body as { formToken: string }).formToken;
      };
      const sendAtOnce = (token: string, address: string) =>
        submit(e2e, form.slug, token, { language: 'en', answers: abstractAnswers() }, { address });

      // Used by a stored submission, then expired: a renewal is not a person any sooner.
      const author = freshAddress();
      const first = await tokenFor(e2e, form.slug, author);
      await ageTokens(owner, orgA());
      expect((await sendAtOnce(first.formToken, author)).status).toBe(201);
      expect(await storedOf()).toBe(1);
      await inOrganisation(
        owner,
        orgA(),
        "UPDATE form_tokens SET expires_at = now() - interval '1 second' WHERE form_id = $1",
        [form.formId],
      );
      const afterStored = await renew(first.formToken, author);
      expect((await sendAtOnce(afterStored, author)).status).toBe(201);
      expect(await storedOf()).toBe(1);

      // Used by a fake success: the same.
      const script = freshAddress();
      const quick = await tokenFor(e2e, form.slug, script);
      expect((await sendAtOnce(quick.formToken, script)).status).toBe(201);
      await ageTokens(owner, orgA());
      const afterDecoy = await renew(quick.formToken, script);
      expect((await sendAtOnce(afterDecoy, script)).status).toBe(201);
      expect(await storedOf()).toBe(1);
    });

    it('refuses answers that break the rules, with the field path and code (FR-FORM-13, ST-41)', async () => {
      const form = await openForm(e2e, admin, {
        configuration: { maxAuthors: 3, fields: { abstract: { maxWords: 5 } } },
      });
      const address = freshAddress();
      const { formToken } = await tokenFor(e2e, form.slug, address);
      await ageTokens(owner, orgA());
      const cases: [Record<string, unknown>, { path: string; code: string }][] = [
        [
          abstractAnswers({ abstract: 'jedan dva tri četiri pet šest' }),
          { path: 'answers.abstract', code: 'tooManyWords' },
        ],
        [
          abstractAnswers({ title: 'Vidite https://example.test' }),
          { path: 'answers.title', code: 'noUrl' },
        ],
        [abstractAnswers({ consent: false }), { path: 'answers.consent', code: 'required' }],
        [
          abstractAnswers({ payer: 'employer' }),
          { path: 'answers.employerName', code: 'required' },
        ],
        [
          JSON.parse(
            `{"__proto__":{"admin":true},${JSON.stringify(abstractAnswers()).slice(1)}`,
          ) as Record<string, unknown>,
          { path: 'answers.__proto__', code: 'unknownField' },
        ],
      ];
      for (const [answers, error] of cases) {
        const response = await submit(
          e2e,
          form.slug,
          formToken,
          { language: 'en', answers },
          { address },
        );
        expect(response.status).toBe(400);
        expect((response.body as { errors: unknown[] }).errors).toContainEqual(error);
      }
      // 500 authors and a megabyte: refused.
      const many = Array.from({ length: 500 }, (_, n) => ({
        firstName: 'A',
        lastName: String(n),
        institution: 'I',
        email: `a${String(n)}@x.example.test`,
      }));
      const crowd = await submit(
        e2e,
        form.slug,
        formToken,
        { language: 'en', answers: abstractAnswers({ authors: many }) },
        { address },
      );
      // 500 short author blocks fit the body cap and are refused by the stated maximum.
      expect(crowd.status).toBe(400);
      expect((crowd.body as { errors: unknown[] }).errors).toContainEqual({
        path: 'answers.authors',
        code: 'tooManyItems',
      });
      const huge = await submit(
        e2e,
        form.slug,
        formToken,
        { language: 'en', answers: abstractAnswers({ abstract: 'x'.repeat(1024 * 1024) }) },
        { address },
      );
      expect(huge.status).toBe(413);
      const four = await submit(
        e2e,
        form.slug,
        formToken,
        {
          language: 'en',
          answers: abstractAnswers({
            authors: Array.from({ length: 4 }, (_, n) => ({
              firstName: 'A',
              lastName: String(n),
              institution: 'I',
              email: `a${String(n)}@x.example.test`,
            })),
          }),
        },
        { address },
      );
      expect((four.body as { errors: unknown[] }).errors).toContainEqual({
        path: 'answers.authors',
        code: 'tooManyItems',
      });
      // Nothing of it was stored; the token still works for a valid submit.
      const ok = await submit(
        e2e,
        form.slug,
        formToken,
        { language: 'en', answers: abstractAnswers({ abstract: 'Kratak apstrakt.' }) },
        { address },
      );
      expect(ok.status).toBe(201);
      // A page size above the maximum is refused.
      expect((await as(e2e, admin, 'get', '/api/v1/submissions?pageSize=101')).status).toBe(400);
    });

    it('the trap field and a submit faster than a person: a fake success, nothing stored (ADR-08)', async () => {
      const form = await openForm(e2e, admin);
      const address = freshAddress();
      const trapped = await tokenFor(e2e, form.slug, address);
      await ageTokens(owner, orgA());
      const trap = await submit(
        e2e,
        form.slug,
        trapped.formToken,
        { language: 'en', answers: abstractAnswers(), confera_hp: 'https://spam.example.test' },
        { address },
      );
      expect(trap.status).toBe(201);
      expect((trap.body as { reference: string }).reference).toMatch(/^[A-Z]{2}\d{2}-\d{4}$/);
      const fast = await tokenFor(e2e, form.slug, address);
      const quick = await submit(
        e2e,
        form.slug,
        fast.formToken,
        { language: 'en', answers: abstractAnswers() },
        { address },
      );
      expect(quick.status).toBe(201);
      const stored = await inOrganisation(
        owner,
        orgA(),
        'SELECT id FROM submissions WHERE form_id = $1',
        [form.formId],
      );
      expect(stored).toEqual([]);
      const mails = await inOrganisation(
        owner,
        orgA(),
        'SELECT id FROM mail_outbox WHERE form_id = $1',
        [form.formId],
      );
      expect(mails).toEqual([]);
    });

    it('a deadline ends at the end of its day; the form closes and opens again on an extension (FR-DL-01 to 03)', async () => {
      const form = await openForm(e2e, admin, { deadline: '2020-01-15' });
      const closed = await page(e2e, 'get', `/public/v1/forms/${form.slug}`);
      expect(closed.body).toEqual(
        expect.objectContaining({ state: 'closed', closedReason: 'deadline_passed' }),
      );
      const refused = await page(
        e2e,
        'post',
        `/public/v1/forms/${form.slug}/tokens`,
        freshAddress(),
      )
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual(expect.objectContaining({ code: 'form_closed' }));

      const deadlines = await as(
        e2e,
        admin,
        'get',
        `/api/v1/conferences/${form.conferenceId}/deadlines`,
      );
      const [current] = (deadlines.body as { items: { version: number }[] }).items;
      const extended = await as(
        e2e,
        admin,
        'put',
        `/api/v1/conferences/${form.conferenceId}/deadlines/abstract_submission`,
      ).send({
        endsOn: '2099-01-15',
        version: current?.version,
      });
      expect(extended.status).toBe(200);
      expect(
        (
          extended.body as {
            history: { oldEndsOn: string | null; newEndsOn: string; changedBy: { id: string } }[];
          }
        ).history[0],
      ).toEqual(
        expect.objectContaining({
          oldEndsOn: '2020-01-15',
          newEndsOn: '2099-01-15',
          changedBy: expect.objectContaining({ id: actors.a.admin.id }),
        }),
      );
      const open = await page(e2e, 'get', `/public/v1/forms/${form.slug}`);
      expect(open.body).toEqual(expect.objectContaining({ state: 'open', deadline: '2099-01-15' }));
      // A deadline that passes while the author types: the submit is refused, nothing stored.
      const address = freshAddress();
      const { formToken } = await tokenFor(e2e, form.slug, address);
      await ageTokens(owner, orgA());
      const deadlinesNow = await as(
        e2e,
        admin,
        'get',
        `/api/v1/conferences/${form.conferenceId}/deadlines`,
      );
      const [now] = (deadlinesNow.body as { items: { version: number }[] }).items;
      await as(
        e2e,
        admin,
        'put',
        `/api/v1/conferences/${form.conferenceId}/deadlines/abstract_submission`,
      ).send({ endsOn: '2020-01-16', version: now?.version });
      const late = await submit(
        e2e,
        form.slug,
        formToken,
        { language: 'en', answers: abstractAnswers() },
        { address },
      );
      expect(late.status).toBe(409);
      expect(late.body).toEqual(expect.objectContaining({ code: 'form_closed' }));
      const audit = await as(e2e, admin, 'get', '/api/v1/audit?action=conference.deadline_changed');
      expect((audit.body as { total: number }).total).toBeGreaterThanOrEqual(3);
    });
  });

  describe('the send breaker and the proof-of-work (ST-34, M3-BE-09)', () => {
    it('submissions from many addresses: all stored, confirmations held above the breaker, the admins told, released by an admin', async () => {
      const form = await openForm(e2e, admin);
      const set = await as(e2e, admin, 'get', `/api/v1/forms/${form.formId}`);
      const breaker = await as(e2e, admin, 'patch', `/api/v1/forms/${form.formId}/breaker`).send({
        breakerPerHour: 3,
        breakerPerDay: 200,
        version: (set.body as { version: number }).version,
      });
      expect(breaker.status).toBe(200);
      const references: string[] = [];
      for (let n = 0; n < 6; n += 1) {
        const address = freshAddress();
        const { formToken } = await tokenFor(e2e, form.slug, address);
        await ageTokens(owner, orgA());
        const response = await submit(
          e2e,
          form.slug,
          formToken,
          { language: 'en', answers: abstractAnswers() },
          { address },
        );
        expect(response.status).toBe(201);
        references.push((response.body as { reference: string }).reference);
      }
      expect(new Set(references).size).toBe(6);
      const statuses = await inOrganisation<{ status: string; held_reason: string | null }>(
        owner,
        orgA(),
        "SELECT status, held_reason FROM mail_outbox WHERE kind = 'submission_confirmation' AND form_id = $1 ORDER BY created_at",
        [form.formId],
      );
      expect(statuses.map((row) => row.status)).toEqual([
        'queued',
        'queued',
        'queued',
        'held',
        'held',
        'held',
      ]);
      expect(statuses[3]?.held_reason).toBe('send_breaker_form');
      const notices = await inOrganisation(
        owner,
        orgA(),
        "SELECT id FROM mail_outbox WHERE kind = 'security_notice' AND parameters->>'change' = 'mail_held'",
      );
      // One notice per admin for the hour, however many were held.
      expect(notices.length).toBe(2);

      const held = await as(e2e, admin, 'get', `/api/v1/held-mail?formId=${form.formId}`);
      expect(held.status).toBe(200);
      expect(held.body).toEqual(expect.objectContaining({ total: 3 }));
      // Why, with the numbers (UX3-06): the 4th confirmation in an hour, above the form's 3.
      expect((held.body as { items: unknown[] }).items[0]).toEqual(
        expect.objectContaining({
          heldReason: 'send_breaker_form',
          heldBy: { count: 4, limit: 3, windowHours: 1 },
        }),
      );
      // One of them is discarded (M3-ISS-14): never sent, never released, with an audit entry.
      const heldIds = (held.body as { items: { id: string }[] }).items.map((item) => item.id);
      const discarded = await as(e2e, admin, 'post', '/api/v1/held-mail/discard').send({
        ids: [heldIds[0]],
      });
      expect(discarded.status).toBe(200);
      expect(discarded.body).toEqual({ discarded: 1 });
      const again = await as(e2e, admin, 'post', '/api/v1/held-mail/discard').send({
        ids: [heldIds[0]],
      });
      expect(again.body).toEqual({ discarded: 0 });
      const released = await as(e2e, admin, 'post', '/api/v1/held-mail/release').send({
        all: true,
        formId: form.formId,
      });
      expect(released.body).toEqual({ released: 2 });
      const after = await inOrganisation<{
        id: string;
        status: string;
        discarded_by: string | null;
      }>(
        owner,
        orgA(),
        "SELECT id, status, discarded_by FROM mail_outbox WHERE kind = 'submission_confirmation' AND form_id = $1",
        [form.formId],
      );
      expect(after.filter((row) => row.status === 'queued')).toHaveLength(5);
      expect(after.find((row) => row.id === heldIds[0])).toEqual(
        expect.objectContaining({ status: 'discarded', discarded_by: actors.a.admin.id }),
      );
      const audit = await as(e2e, admin, 'get', '/api/v1/audit?action=held_mail.discarded');
      expect(audit.body).toEqual(expect.objectContaining({ total: 1 }));
      expect((await as(e2e, adminB, 'get', '/api/v1/held-mail')).body).toEqual(
        expect.objectContaining({ total: 0 }),
      );
    });

    it('asks a client that behaved like a script for a proof-of-work, and refuses a submit without it (Q3-08)', async () => {
      const form = await openForm(e2e, admin);
      const address = freshAddress();
      // Many tokens alone (a faculty behind one address) ask for no work ...
      for (let n = 0; n < 12; n += 1) {
        expect((await tokenFor(e2e, form.slug, address)).proofOfWork).toBeNull();
      }
      // ... three acts of a script do: the trap, filled three times.
      for (let n = 0; n < 3; n += 1) {
        const trapped = await tokenFor(e2e, form.slug, address);
        await ageTokens(owner, orgA());
        await submit(
          e2e,
          form.slug,
          trapped.formToken,
          { language: 'en', answers: abstractAnswers(), confera_hp: 'x' },
          { address },
        );
      }
      const { formToken, proofOfWork } = await tokenFor(e2e, form.slug, address);
      expect(proofOfWork).not.toBeNull();
      await ageTokens(owner, orgA());
      const without = await submit(
        e2e,
        form.slug,
        formToken,
        { language: 'en', answers: abstractAnswers() },
        { address },
      );
      expect(without.status).toBe(403);
      expect(without.body).toEqual(expect.objectContaining({ code: 'proof_of_work_failed' }));
      expect(proofOfWork?.difficulty).toBe(13);
      const counter = solveProofOfWork(proofOfWork?.challenge ?? '', proofOfWork?.difficulty ?? 13);
      const withIt = await submit(
        e2e,
        form.slug,
        formToken,
        { language: 'en', answers: abstractAnswers(), proofOfWork: counter },
        { address },
      );
      expect(withIt.status).toBe(201);
    });

    it('a page that sends the trap three times under one key is asked for a proof-of-work too (UX review of 0.3.0)', async () => {
      const form = await openForm(e2e, admin);
      const address = freshAddress();
      const trapped = await tokenFor(e2e, form.slug, address);
      await ageTokens(owner, orgA());
      const key = randomUUID();
      const body = { language: 'en', answers: abstractAnswers(), confera_hp: 'x' };
      const references = new Set<string>();
      // The page keeps its key per form instance: Send, Send, Send. The repeats answer the
      // first fake success, and each is an act of a script as the first was.
      for (let n = 0; n < 3; n += 1) {
        const fake = await submit(e2e, form.slug, trapped.formToken, body, { address, key });
        expect(fake.status).toBe(201);
        references.add((fake.body as { reference: string }).reference);
      }
      expect(references.size).toBe(1);
      expect((await tokenFor(e2e, form.slug, address)).proofOfWork).not.toBeNull();
      // Another client is not touched by it.
      expect((await tokenFor(e2e, form.slug, freshAddress())).proofOfWork).toBeNull();
    });

    it('the breaker of the organisation holds the confirmations of all its forms (ADR-08)', async () => {
      const form = await openForm(e2e, admin);
      const before = await as(e2e, admin, 'get', '/api/v1/held-mail');
      const { breaker } = before.body as { breaker: { version: number } };
      const set = await as(e2e, admin, 'patch', '/api/v1/held-mail/breaker').send({
        perHour: 1,
        perDay: 200,
        version: breaker.version,
      });
      expect(set.status).toBe(200);
      expect((set.body as { breaker: { perHour: number } }).breaker.perHour).toBe(1);
      try {
        const address = freshAddress();
        const { formToken } = await tokenFor(e2e, form.slug, address);
        await ageTokens(owner, orgA());
        const response = await submit(
          e2e,
          form.slug,
          formToken,
          { language: 'en', answers: abstractAnswers() },
          { address },
        );
        expect(response.status).toBe(201);
        const [row] = await inOrganisation<{ status: string; held_reason: string }>(
          owner,
          orgA(),
          "SELECT status, held_reason FROM mail_outbox WHERE kind = 'submission_confirmation' AND form_id = $1",
          [form.formId],
        );
        expect(row).toEqual({ status: 'held', held_reason: 'send_breaker_organisation' });
        const audit = await as(
          e2e,
          admin,
          'get',
          '/api/v1/audit?action=organisation.breaker_changed',
        );
        expect((audit.body as { items: { changes: unknown }[] }).items[0]?.changes).toEqual({
          breakerPerHour: { old: '30', new: '1' },
        });
      } finally {
        const now = await as(e2e, admin, 'get', '/api/v1/held-mail');
        await as(e2e, admin, 'patch', '/api/v1/held-mail/breaker').send({
          perHour: 30,
          perDay: 200,
          version: (now.body as { breaker: { version: number } }).breaker.version,
        });
      }
    });

    it('limits the token fetches of one address (NFR-SEC-02)', async () => {
      const form = await openForm(e2e, admin);
      const address = freshAddress();
      const statuses: number[] = [];
      for (let n = 0; n < 32; n += 1) {
        const response = await page(e2e, 'post', `/public/v1/forms/${form.slug}/tokens`, address)
          .set('Content-Type', 'application/json')
          .send('{}');
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 30).every((status) => status === 201)).toBe(true);
      expect(statuses.slice(30)).toEqual([429, 429]);
    });
  });
});
