import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { FilesWorker } from '../../src/modules/files/files-worker';
import { UploadsService } from '../../src/modules/files/uploads.service';
import { type FakeClamd, startFakeClamd } from '../support/fake-clamd';
import { docOf, docxOf, EICAR, pdfOf } from '../support/office-files';
import { type Actors, as, createActors, type SignedIn, signIn } from './support/actors';
import {
  ADMIN_HOST,
  type E2eApp,
  e2eEnvironment,
  PUBLIC_HOST,
  startE2eApp,
} from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';
import {
  abstractAnswers,
  ageTokens,
  freshAddress,
  inOrganisation,
  type OpenForm,
  openForm,
  page,
  submit,
  tokenFor,
} from './support/forms';

/**
 * Files of the public forms end to end, on the configuration of a server (M3-BE-04,
 * M3-BE-08; FR-FILE-01 to 03, FR-FORM-10, NFR-SEC-06; ST-32, ST-33, ST-38, ST-39, ST-65 for
 * uploads). The antivirus is the fake clamd of the tests, spoken to by the real client.
 */
const MB = 1024 * 1024;

describe('uploads, scans and downloads (M3-BE-04, M3-BE-08)', () => {
  jest.setTimeout(300_000);

  let owner: Client;
  let clamd: FakeClamd;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  let adminB: SignedIn;
  let files: FilesWorker;
  let form: OpenForm;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    clamd = await startFakeClamd('clean');
    e2e = await startE2eApp(e2eEnvironment({ CLAMAV_ADDRESS: clamd.address }));
    files = e2e.app.get(FilesWorker);
    actors = await createActors(e2e, owner);
    await new Factories(owner).templates(actors.a.organisation.id);
    admin = await signIn(e2e, actors.a.admin);
    adminB = await signIn(e2e, actors.b.admin);
    form = await openForm(e2e, admin);
  });

  afterAll(async () => {
    await e2e.close();
    await clamd.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  const orgA = () => actors.a.organisation.id;

  function upload(
    slug: string,
    token: string | null,
    content: Buffer,
    name: string,
    options: { field?: string; address?: string } = {},
  ) {
    let call = page(
      e2e,
      'post',
      `/public/v1/forms/${slug}/uploads`,
      options.address ?? '203.0.113.20',
    );
    if (token !== null) {
      call = call.set('X-Form-Token', token);
    }
    return call.field('field', options.field ?? 'biographies').attach('file', content, name);
  }

  async function submitted(token: string, address: string, fileId: string): Promise<string> {
    await ageTokens(owner, orgA());
    const response = await submit(
      e2e,
      form.slug,
      token,
      { language: 'en', answers: abstractAnswers({ biographies: fileId }) },
      { address },
    );
    expect(response.status).toBe(201);
    const [row] = await inOrganisation<{ id: string }>(
      owner,
      orgA(),
      'SELECT id FROM submissions WHERE reference = $1',
      [(response.body as { reference: string }).reference],
    );
    return row?.id ?? '';
  }

  it('a file goes in, is attached, waits for its scan, and downloads once clean, under its own name', async () => {
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    const content = pdfOf(5000);
    const uploaded = await upload(form.slug, formToken, content, 'Biografije Šćepanović "1".pdf', {
      address,
    });
    expect(uploaded.status).toBe(201);
    const file = uploaded.body as { fileId: string; name: string; type: string; sizeBytes: number };
    expect(file).toEqual(
      expect.objectContaining({
        name: 'Biografije Šćepanović _1_.pdf',
        type: 'pdf',
        sizeBytes: 5000,
      }),
    );
    const submission = await submitted(formToken, address, file.fileId);
    const path = `/api/v1/submissions/${submission}/files/${file.fileId}`;
    // Pending: not served, also not "anyway" (ST-38).
    const early = await as(e2e, admin, 'get', path);
    expect(early.status).toBe(409);
    expect(early.body).toEqual(expect.objectContaining({ code: 'scan_pending' }));
    const report = await files.tick();
    expect(report.clean).toBeGreaterThanOrEqual(1);
    const download = await as(e2e, admin, 'get', path)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          done(null, Buffer.concat(chunks));
        });
      });
    expect(download.status).toBe(200);
    expect(Buffer.compare(download.body as Buffer, content)).toBe(0);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="Biografije Scepanovic _1_.pdf"; filename*=UTF-8''Biografije%20%C5%A0%C4%87epanovi%C4%87%20_1_.pdf`,
    );
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    // The other organisation: not found, also by a guessed or copied address.
    expect((await as(e2e, adminB, 'get', path)).status).toBe(404);
    expect((await as(e2e, null, 'get', path)).status).toBe(401);
    const detail = await as(e2e, admin, 'get', `/api/v1/submissions/${submission}`);
    expect((detail.body as { files: unknown[] }).files).toEqual([
      expect.objectContaining({
        id: file.fileId,
        field: 'biographies',
        scanState: 'clean',
        scanFlag: null,
      }),
    ]);
  });

  it('20 MB are taken, one byte more is refused before it is stored (FR-FILE-01)', async () => {
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    const exact = await upload(form.slug, formToken, pdfOf(20 * MB), 'velik.pdf', { address });
    expect(exact.status).toBe(201);
    const over = await upload(form.slug, formToken, pdfOf(20 * MB + 1), 'prevelik.pdf', {
      address,
    });
    expect(over.status).toBe(413);
    expect(over.body).toEqual(expect.objectContaining({ code: 'file_too_large' }));
    const rows = await inOrganisation(
      owner,
      orgA(),
      "SELECT id FROM files WHERE original_name = 'prevelik.pdf'",
    );
    expect(rows).toEqual([]);
  });

  it('the type is read from the content; macros follow the decided policy (NFR-SEC-06, G2-22)', async () => {
    const address = freshAddress();
    const one = await tokenFor(e2e, form.slug, address);
    const exe = await upload(
      form.slug,
      one.formToken,
      Buffer.from('MZ\x90\0\x03\0\0\0this is not a pdf'),
      'cv.pdf',
      { address },
    );
    expect(exe.status).toBe(415);
    expect(exe.body).toEqual(expect.objectContaining({ code: 'file_type_refused' }));
    const two = await tokenFor(e2e, form.slug, address);
    const docm = await upload(form.slug, two.formToken, docxOf({ macros: true }), 'cv.docx', {
      address,
    });
    expect(docm.status).toBe(422);
    expect(docm.body).toEqual(expect.objectContaining({ code: 'docx_macros' }));
    const html = await upload(
      form.slug,
      two.formToken,
      Buffer.from('<script>alert(1)</script>'),
      'cv.doc',
      { address },
    );
    expect(html.status).toBe(415);
    const three = await tokenFor(e2e, form.slug, address);
    const doc = await upload(form.slug, three.formToken, docOf({ macros: true }), 'stari.doc', {
      address,
    });
    expect(doc.status).toBe(201);
    const submission = await submitted(
      three.formToken,
      address,
      (doc.body as { fileId: string }).fileId,
    );
    const detail = await as(e2e, admin, 'get', `/api/v1/submissions/${submission}`);
    expect((detail.body as { files: unknown[] }).files).toEqual([
      expect.objectContaining({ type: 'doc', scanFlag: 'macros' }),
    ]);
  });

  it('ST-32: no token, another form’s token, too many uploads, a file of another token, attached twice', async () => {
    const other = await openForm(e2e, admin);
    const address = freshAddress();
    const mine = await tokenFor(e2e, form.slug, address);
    const theirs = await tokenFor(e2e, other.slug, address);
    expect((await upload(form.slug, null, pdfOf(), 'a.pdf', { address })).status).toBe(403);
    expect((await upload(form.slug, 'A'.repeat(43), pdfOf(), 'a.pdf', { address })).status).toBe(
      403,
    );
    expect((await upload(form.slug, theirs.formToken, pdfOf(), 'a.pdf', { address })).status).toBe(
      403,
    );
    expect(
      (await upload(form.slug, mine.formToken, pdfOf(), 'a.pdf', { address, field: 'title' }))
        .status,
    ).toBe(400);
    // One file field and a margin of two: three uploads, then no more.
    const first = await upload(form.slug, mine.formToken, pdfOf(), 'a.pdf', { address });
    expect(first.status).toBe(201);
    expect((await upload(form.slug, mine.formToken, pdfOf(), 'b.pdf', { address })).status).toBe(
      201,
    );
    // The upload to the wrong field above was refused and used none up (Q3-04).
    expect((await upload(form.slug, mine.formToken, pdfOf(), 'c.pdf', { address })).status).toBe(
      201,
    );
    const fourth = await upload(form.slug, mine.formToken, pdfOf(), 'd.pdf', { address });
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual(expect.objectContaining({ code: 'too_many_uploads' }));
    // A file uploaded with one token cannot be attached with another.
    const fileId = (first.body as { fileId: string }).fileId;
    const second = await tokenFor(e2e, form.slug, address);
    await ageTokens(owner, orgA());
    const foreign = await submit(
      e2e,
      form.slug,
      second.formToken,
      { language: 'en', answers: abstractAnswers({ biographies: fileId }) },
      { address },
    );
    expect(foreign.status).toBe(400);
    expect((foreign.body as { errors: unknown[] }).errors).toContainEqual({
      path: 'answers.biographies',
      code: 'fileUnknown',
    });
    // Attached once with its own token; a second submission cannot take it again.
    await submitted(mine.formToken, address, fileId);
    const third = await tokenFor(e2e, form.slug, address);
    await ageTokens(owner, orgA());
    const twice = await submit(
      e2e,
      form.slug,
      third.formToken,
      { language: 'en', answers: abstractAnswers({ biographies: fileId }) },
      { address },
    );
    expect(twice.status).toBe(400);
    // An upload as a JSON body, or from another site, is refused.
    const json = await page(e2e, 'post', `/public/v1/forms/${form.slug}/uploads`, address)
      .set('X-Form-Token', third.formToken)
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(json.status).toBe(415);
    const crossSite = await upload(form.slug, third.formToken, pdfOf(), 'x.pdf', { address }).set(
      'Origin',
      'https://www.konferencija.example.test',
    );
    expect(crossSite.status).toBe(403);
  });

  it('ST-33: above the quota of unattached bytes uploads are refused and the admins told; the purge removes file and row', async () => {
    const uploads = e2e.app.get(UploadsService);
    const address = freshAddress();
    const { formToken } = await tokenFor(e2e, form.slug, address);
    const kept = await upload(form.slug, formToken, pdfOf(), 'ostaje.pdf', { address });
    expect(kept.status).toBe(201);
    uploads.quotaBytes = 1;
    try {
      const refused = await upload(form.slug, formToken, pdfOf(), 'puno.pdf', { address });
      expect(refused.status).toBe(503);
      expect(refused.body).toEqual(expect.objectContaining({ code: 'upload_quota_reached' }));
      const notices = await inOrganisation(
        owner,
        orgA(),
        "SELECT id FROM mail_outbox WHERE parameters->>'change' = 'upload_quota_reached'",
      );
      expect(notices.length).toBeGreaterThan(0);
    } finally {
      uploads.quotaBytes = 2 * 1024 * MB;
    }
    // The token expires: its unattached files go, file and row.
    const keptId = (kept.body as { fileId: string }).fileId;
    const [before] = await inOrganisation<{ storage_key: string }>(
      owner,
      orgA(),
      'SELECT storage_key FROM files WHERE id = $1',
      [keptId],
    );
    await inOrganisation(
      owner,
      orgA(),
      // Expired more than the grace of an hour ago, and issued more than a day ago.
      "UPDATE form_tokens SET expires_at = now() - interval '2 hours', issued_at = now() - interval '25 hours'",
    );
    const report = await files.tick();
    expect(report.purged).toBeGreaterThanOrEqual(1);
    expect(
      await inOrganisation(owner, orgA(), 'SELECT id FROM files WHERE id = $1', [keptId]),
    ).toEqual([]);
    expect(await inOrganisation(owner, orgA(), 'SELECT id FROM form_tokens')).toEqual([]);
    // ST-65 for uploads: a stored file asked for by its storage key under any prefix is not found.
    const key = before?.storage_key ?? '';
    for (const host of [ADMIN_HOST, PUBLIC_HOST]) {
      for (const prefix of [
        '/',
        '/api/v1/',
        '/public/v1/',
        '/files/',
        '/uploads/',
        '/tmp/e2e-files/',
      ]) {
        const response = await e2e.http().get(`${prefix}${key}`).set('Host', host);
        expect({ prefix, status: response.status }).toEqual({ prefix, status: 404 });
      }
    }
  });

  it('ST-38: with ClamAV down a file stays pending and the admins are told; infected and over its limits is never served', async () => {
    const address = freshAddress();
    const one = await tokenFor(e2e, form.slug, address);
    const clean = await upload(form.slug, one.formToken, pdfOf(), 'cekanje.pdf', { address });
    const cleanId = (clean.body as { fileId: string }).fileId;
    const pending = await submitted(one.formToken, address, cleanId);
    clamd.mode = 'error';
    await files.tick();
    const path = `/api/v1/submissions/${pending}/files/${cleanId}`;
    expect((await as(e2e, admin, 'get', path)).body).toEqual(
      expect.objectContaining({ code: 'scan_pending' }),
    );
    const [row] = await inOrganisation<{ scan_state: string; scan_attempts: number }>(
      owner,
      orgA(),
      'SELECT scan_state, scan_attempts FROM files WHERE id = $1',
      [cleanId],
    );
    expect(row).toEqual({ scan_state: 'pending', scan_attempts: 1 });
    const alerts = await inOrganisation(
      owner,
      orgA(),
      "SELECT id FROM mail_outbox WHERE parameters->>'change' = 'virus_scan_pending'",
    );
    expect(alerts.length).toBeGreaterThan(0);
    clamd.mode = 'clean';

    const two = await tokenFor(e2e, form.slug, address);
    const infected = await upload(
      form.slug,
      two.formToken,
      Buffer.concat([pdfOf(100), Buffer.from(EICAR)]),
      'virus.pdf',
      { address },
    );
    const infectedId = (infected.body as { fileId: string }).fileId;
    const infectedSubmission = await submitted(two.formToken, address, infectedId);
    await inOrganisation(owner, orgA(), 'UPDATE files SET next_scan_at = now()');
    await files.tick();
    const infectedPath = `/api/v1/submissions/${infectedSubmission}/files/${infectedId}`;
    expect((await as(e2e, admin, 'get', infectedPath)).body).toEqual(
      expect.objectContaining({ code: 'file_not_clean' }),
    );

    clamd.mode = 'limits';
    const three = await tokenFor(e2e, form.slug, address);
    const large = await upload(form.slug, three.formToken, pdfOf(), 'granice.pdf', { address });
    const largeId = (large.body as { fileId: string }).fileId;
    await submitted(three.formToken, address, largeId);
    await files.tick();
    const [limited] = await inOrganisation<{ scan_state: string }>(
      owner,
      orgA(),
      'SELECT scan_state FROM files WHERE id = $1',
      [largeId],
    );
    expect(limited?.scan_state).toBe('not_clean');
    clamd.mode = 'clean';
    // The submission itself was never blocked by a scan.
    const list = await as(e2e, admin, 'get', '/api/v1/submissions?pageSize=100');
    expect((list.body as { total: number }).total).toBeGreaterThanOrEqual(3);
    expect(randomUUID()).toMatch(/-/);
  });
});
