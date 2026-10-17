import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { Client } from 'pg';
import { MailWorker } from '../../src/modules/mail/mail-worker';
import { solveProofOfWork } from '../../src/modules/forms/proof-of-work';
import { pdfOf, zipOf } from '../support/office-files';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import {
  type E2eApp,
  e2eLocalEnvironment,
  PUBLIC_HOST,
  startE2eApp,
  TEST_FILE_DIRECTORY,
} from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
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
 * The Test engineer's and Edge-case hunter's probes of 0.3.0 (M3-QA-03, M3-REV-01): where
 * the public form API, the uploads and the breaker meet a determined client. Tests that
 * fail here are findings (Q3-nn in the report of milestone 0.3.0); the ones that pass hold
 * a control that had no test of its own.
 */
describe('0.3.0 edge probes of the public forms (Q3)', () => {
  jest.setTimeout(300_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  let adminB: SignedIn;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp(e2eLocalEnvironment());
    actors = await createActors(e2e, owner);
    await new Factories(owner).templates(actors.a.organisation.id);
    await new Factories(owner).templates(actors.b.organisation.id);
    admin = await signIn(e2e, actors.a.admin);
    adminB = await signIn(e2e, actors.b.admin);
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  const orgA = () => actors.a.organisation.id;

  async function storedOf(formId: string): Promise<number> {
    const rows = await inOrganisation(
      owner,
      orgA(),
      'SELECT id FROM submissions WHERE form_id = $1',
      [formId],
    );
    return rows.length;
  }

  function upload(slug: string, token: string, content: Buffer, name: string, address: string) {
    return page(e2e, 'post', `/public/v1/forms/${slug}/uploads`, address)
      .set('X-Form-Token', token)
      .field('field', 'biographies')
      .attach('file', content, name);
  }

  it('Q3-02: a token fetched before the form got busy still has to prove its work once it is busy (ST-34)', async () => {
    const form = await openForm(e2e, admin);
    // A quiet form: the hoarded token carries no challenge.
    const hoarder = freshAddress();
    const hoarded = await tokenFor(e2e, form.slug, hoarder);
    expect(hoarded.proofOfWork).toBeNull();
    // Then the form gets busy: 21 submissions in ten minutes, from 21 addresses.
    const flood: { address: string; formToken: string }[] = [];
    for (let n = 0; n < 21; n += 1) {
      const address = freshAddress();
      flood.push({ address, formToken: (await tokenFor(e2e, form.slug, address)).formToken });
    }
    await ageTokens(owner, orgA());
    for (const { address, formToken } of flood) {
      const sent = await submit(
        e2e,
        form.slug,
        formToken,
        { language: 'en', answers: abstractAnswers() },
        { address },
      );
      expect(sent.status).toBe(201);
    }
    // Above the threshold a new token asks for the work...
    expect((await tokenFor(e2e, form.slug, freshAddress())).proofOfWork).not.toBeNull();
    // ...and so must a token that was fetched while the form was quiet.
    const late = await submit(
      e2e,
      form.slug,
      hoarded.formToken,
      { language: 'en', answers: abstractAnswers() },
      { address: hoarder },
    );
    expect(late.status).toBe(403);
    expect(late.body).toEqual(expect.objectContaining({ code: 'proof_of_work_failed' }));
  });

  it('Q3-03: the addresses of one IPv6 /64 share the limits of one address (NFR-SEC-02, ADR-08)', async () => {
    const form = await openForm(e2e, admin);
    const statuses: number[] = [];
    // One household, one machine: every address of 2001:db8:3:4::/64 is the same client.
    for (let n = 1; n <= 31; n += 1) {
      const response = await page(
        e2e,
        'post',
        `/public/v1/forms/${form.slug}/tokens`,
        `2001:db8:3:4::${n.toString(16)}`,
      )
        .set('Content-Type', 'application/json')
        .send('{}');
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('Q3-04: an upload that the API refuses does not use up the uploads of the token (FR-FORM-10)', async () => {
    const form = await openForm(e2e, admin);
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    // An author picks the wrong file three times (a picture, a text, a picture): each is refused.
    for (const name of ['slika.png', 'beleske.txt', 'slika2.png']) {
      const refused = await upload(
        form.slug,
        formToken,
        Buffer.from('not a document'),
        name,
        address,
      );
      expect(refused.status).toBe(415);
    }
    // The fourth is the right one: it must be taken, the token stored nothing yet.
    const right = await upload(form.slug, formToken, pdfOf(), 'Biografije.pdf', address);
    expect(right.status).toBe(201);
  });

  it('Q3-05: an upload cut off in the middle leaves no temporary file behind', async () => {
    const form = await openForm(e2e, admin);
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    const incoming = join(TEST_FILE_DIRECTORY, 'incoming');
    const before = new Set(await readdir(incoming).catch(() => [] as string[]));
    const url = new URL(`${e2e.baseUrl}/public/v1/forms/${form.slug}/uploads`);
    const boundary = `----confera${randomUUID()}`;
    await new Promise<void>((resolve) => {
      const call = httpRequest({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          Host: PUBLIC_HOST,
          Origin: e2e.config.origins.public,
          'Sec-Fetch-Site': 'same-origin',
          'X-Forwarded-For': address,
          'X-Form-Token': formToken,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(5 * 1024 * 1024),
        },
      });
      call.on('error', () => {
        resolve();
      });
      call.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nbiographies\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Rad.pdf"\r\n` +
          'Content-Type: application/pdf\r\n\r\n',
      );
      call.write(pdfOf(1024 * 1024));
      // The train goes into a tunnel: the connection is gone in the middle of the file.
      setTimeout(() => {
        call.destroy();
        resolve();
      }, 500);
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const left = (await readdir(incoming).catch(() => [] as string[])).filter(
      (name) => !before.has(name),
    );
    expect(left).toEqual([]);
  });

  it('Q3-06: 100 confirmations a day go to one recipient domain, the 101st is held (ADR-08, M3-BE-09)', async () => {
    const form = await openForm(e2e, admin);
    const set = await as(e2e, admin, 'get', `/api/v1/forms/${form.formId}`);
    await as(e2e, admin, 'patch', `/api/v1/forms/${form.formId}/breaker`).send({
      breakerPerHour: 10_000,
      breakerPerDay: 100_000,
      version: (set.body as { version: number }).version,
    });
    const before = await as(e2e, admin, 'get', '/api/v1/held-mail');
    await as(e2e, admin, 'patch', '/api/v1/held-mail/breaker').send({
      perHour: 10_000,
      perDay: 100_000,
      version: (before.body as { breaker: { version: number } }).breaker.version,
    });
    const domain = `${randomUUID().slice(0, 8)}.example.test`;
    try {
      for (let n = 1; n <= 101; n += 1) {
        const address = freshAddress();
        const { formToken, proofOfWork } = await tokenFor(e2e, form.slug, address);
        await ageTokens(owner, orgA());
        const counter =
          proofOfWork === null
            ? undefined
            : solveProofOfWork(proofOfWork.challenge, proofOfWork.difficulty);
        const answers = abstractAnswers();
        (answers.authors as Record<string, unknown>[])[0]!.email = `autor${String(n)}@${domain}`;
        const sent = await submit(
          e2e,
          form.slug,
          formToken,
          { language: 'en', answers, ...(counter === undefined ? {} : { proofOfWork: counter }) },
          { address },
        );
        expect(sent.status).toBe(201);
      }
      const rows = await inOrganisation<{ held_reason: string | null }>(
        owner,
        orgA(),
        "SELECT held_reason FROM mail_outbox WHERE kind = 'submission_confirmation' AND form_id = $1 ORDER BY created_at",
        [form.formId],
      );
      expect(rows).toHaveLength(101);
      expect(rows.filter((row) => row.held_reason === null)).toHaveLength(100);
      expect(rows[100]?.held_reason).toBe('recipient_domain');
    } finally {
      const now = await as(e2e, admin, 'get', '/api/v1/held-mail');
      await as(e2e, admin, 'patch', '/api/v1/held-mail/breaker').send({
        perHour: 30,
        perDay: 200,
        version: (now.body as { breaker: { version: number } }).breaker.version,
      });
    }
  });

  it('Q3-07: the fake success of the trap cannot be told from a real one (ADR-08, item 7)', async () => {
    const form = await openForm(e2e, admin);
    const address = freshAddress();
    const real = await tokenFor(e2e, form.slug, address);
    const trapped = await tokenFor(e2e, form.slug, address);
    await ageTokens(owner, orgA());
    const genuine = await submit(
      e2e,
      form.slug,
      real.formToken,
      { language: 'en', answers: abstractAnswers() },
      { address },
    );
    expect(genuine.status).toBe(201);
    const key = randomUUID();
    const body = {
      language: 'en',
      answers: abstractAnswers(),
      website: 'https://spam.example.test',
    };
    const fake = await submit(e2e, form.slug, trapped.formToken, body, { address, key });
    expect(fake.status).toBe(201);
    const shape = (reference: string) => reference.replace(/\d{4}$/, '');
    // A bot compares the two: the fake must carry the conference's edition, as a real one does...
    expect(shape((fake.body as { reference: string }).reference)).toBe(
      shape((genuine.body as { reference: string }).reference),
    );
    // ...and a repeat of the same key must answer the same, as a real repeat does.
    const again = await submit(e2e, form.slug, trapped.formToken, body, { address, key });
    expect((again.body as { reference?: string }).reference).toBe(
      (fake.body as { reference: string }).reference,
    );
  });

  it('holds: a flood of submits at the same moment from many addresses stops at the breaker (ST-34)', async () => {
    const form = await openForm(e2e, admin);
    const set = await as(e2e, admin, 'get', `/api/v1/forms/${form.formId}`);
    await as(e2e, admin, 'patch', `/api/v1/forms/${form.formId}/breaker`).send({
      breakerPerHour: 3,
      breakerPerDay: 200,
      version: (set.body as { version: number }).version,
    });
    // The organisation's own breaker out of the way: only the form's is under test here.
    const organisation = await as(e2e, admin, 'get', '/api/v1/held-mail');
    await as(e2e, admin, 'patch', '/api/v1/held-mail/breaker').send({
      perHour: 10_000,
      perDay: 100_000,
      version: (organisation.body as { breaker: { version: number } }).breaker.version,
    });
    const flood: { address: string; formToken: string }[] = [];
    for (let n = 0; n < 15; n += 1) {
      const address = freshAddress();
      flood.push({ address, formToken: (await tokenFor(e2e, form.slug, address)).formToken });
    }
    await ageTokens(owner, orgA());
    const answers = await Promise.all(
      flood.map(({ address, formToken }) =>
        submit(
          e2e,
          form.slug,
          formToken,
          { language: 'en', answers: abstractAnswers() },
          { address },
        ),
      ),
    );
    expect(answers.map((answer) => answer.status)).toEqual(Array(15).fill(201));
    expect(await storedOf(form.formId)).toBe(15);
    const rows = await inOrganisation<{ status: string }>(
      owner,
      orgA(),
      "SELECT status FROM mail_outbox WHERE kind = 'submission_confirmation' AND form_id = $1",
      [form.formId],
    );
    expect(rows.filter((row) => row.status === 'queued')).toHaveLength(3);
    expect(rows.filter((row) => row.status === 'held')).toHaveLength(12);
    const now = await as(e2e, admin, 'get', '/api/v1/held-mail');
    await as(e2e, admin, 'patch', '/api/v1/held-mail/breaker').send({
      perHour: 30,
      perDay: 200,
      version: (now.body as { breaker: { version: number } }).breaker.version,
    });
  });

  it('holds: a token, a file and a key of the other organisation are worth nothing here', async () => {
    const mine = await openForm(e2e, admin);
    const theirs = await openForm(e2e, adminB);
    const address = freshAddress();
    const foreign = await tokenFor(e2e, theirs.slug, address);
    const foreignFile = await upload(theirs.slug, foreign.formToken, pdfOf(), 'Tuđe.pdf', address);
    expect(foreignFile.status).toBe(201);
    await ageTokens(owner, orgA());
    await ageTokens(owner, actors.b.organisation.id);
    // B's token on A's form.
    const crossed = await submit(
      e2e,
      mine.slug,
      foreign.formToken,
      { language: 'en', answers: abstractAnswers() },
      { address },
    );
    expect(crossed.status).toBe(403);
    // B's file in A's answers.
    const own = await tokenFor(e2e, mine.slug, address);
    await ageTokens(owner, orgA());
    const withFile = await submit(
      e2e,
      mine.slug,
      own.formToken,
      {
        language: 'en',
        answers: abstractAnswers({ biographies: (foreignFile.body as { fileId: string }).fileId }),
      },
      { address },
    );
    expect(withFile.status).toBe(400);
    expect((withFile.body as { errors: unknown[] }).errors).toContainEqual({
      path: 'answers.biographies',
      code: 'fileUnknown',
    });
    expect(await storedOf(mine.formId)).toBe(0);
  });

  it('holds: with the mail server down the submission is stored and the mail log shows the failure', async () => {
    await confirmPassword(e2e, adminB);
    const server = await as(e2e, adminB, 'post', '/api/v1/mail-servers').send({
      name: 'Ugašen',
      host: '127.0.0.1',
      port: 9,
      tlsMode: 'none',
      fromAddress: 'office@b.example.test',
      fromName: 'Ured',
      isDefault: true,
      sendRatePerMinute: 600,
    });
    expect(server.status).toBe(201);
    const form = await openForm(e2e, adminB);
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    await ageTokens(owner, actors.b.organisation.id);
    const sent = await submit(
      e2e,
      form.slug,
      formToken,
      { language: 'sr', answers: abstractAnswers({ title: 'Šta kada pošta ne radi' }) },
      { address },
    );
    expect(sent.status).toBe(201);
    // The outbox of the other organisation is older; a few ticks reach this one.
    for (let n = 0; n < 10; n += 1) {
      await e2e.app.get(MailWorker).tick();
    }
    const stored = await inOrganisation<{ title: string }>(
      owner,
      actors.b.organisation.id,
      'SELECT title FROM submissions WHERE form_id = $1',
      [form.formId],
    );
    expect(stored).toEqual([{ title: 'Šta kada pošta ne radi' }]);
    const log = await inOrganisation<{ result: string }>(
      owner,
      actors.b.organisation.id,
      "SELECT result FROM mail_log WHERE kind = 'submission_confirmation'",
    );
    expect(log.map((row) => row.result)).toContain('failed');
  });

  it('holds: a Belgrade deadline closes at midnight in Belgrade, not in UTC (FR-DL-01)', async () => {
    const created = await as(e2e, admin, 'post', '/api/v1/conferences').send({
      name: 'Beogradski rok (izmišljeno)',
      code: 'BG',
      editionYear: 2099,
      languages: ['en', 'sr'],
      timeZone: 'Europe/Belgrade',
      listedSites: ['https://www.konferencija.example.test'],
    });
    expect(created.status).toBe(201);
    const { id } = created.body as { id: string };
    const set = await as(
      e2e,
      admin,
      'put',
      `/api/v1/conferences/${id}/deadlines/abstract_submission`,
    ).send({
      endsOn: '2099-07-15',
    });
    expect(set.status).toBe(200);
    const read = await as(e2e, admin, 'get', `/api/v1/conferences/${id}/deadlines`);
    expect((read.body as { items: { endsAt: string }[] }).items[0]?.endsAt).toBe(
      '2099-07-15T22:00:00.000Z',
    );
  });

  it('holds: a docx whose directory claims more entries than any document reads in bounded time', async () => {
    const form = await openForm(e2e, admin);
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    const entries: Record<string, string> = {
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document/>',
    };
    for (let n = 0; n < 10_001; n += 1) {
      entries[`word/media/a${String(n)}.bin`] = '';
    }
    const started = Date.now();
    const bomb = await upload(form.slug, formToken, zipOf(entries), 'Rad.docx', address);
    expect(bomb.status).toBe(415);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('holds: once the conference closes submissions its form may be framed nowhere (ADR-07, ST-36)', async () => {
    const form = await openForm(e2e, admin, {
      listedSites: ['https://www.konferencija.example.test'],
    });
    const open = await page(e2e, 'get', `/public/v1/forms/${form.slug}/frame-sites`);
    expect(open.body).toEqual({ sites: ['https://www.konferencija.example.test'] });
    const conference = await as(e2e, admin, 'get', `/api/v1/conferences/${form.conferenceId}`);
    const closed = await as(
      e2e,
      admin,
      'post',
      `/api/v1/conferences/${form.conferenceId}/state`,
    ).send({
      state: 'closed',
      version: (conference.body as { version: number }).version,
    });
    expect([200, 201]).toContain(closed.status);
    const after = await page(e2e, 'get', `/public/v1/forms/${form.slug}/frame-sites`);
    expect(after.body).toEqual({ sites: [] });
  });
});
