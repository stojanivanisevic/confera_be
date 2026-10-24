import type { Client } from 'pg';
import { searchTextOf } from '../../src/modules/submissions/search';
import { as, createActors, type Actors, type SignedIn } from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * M4-QA-02 (Test engineer, 0.4.0), NFR-PERF-02: the submissions table answers a search or a
 * filter within one second with 20,000 submissions stored. The builder's timing test plants
 * rows without files; a real row has its files, and the table reads each row's scan signs
 * (FR-FILE-02), so here every submission has two files, one in five still pending and one in
 * fifty flagged. Every order of the fixed map, the deepest page, a search that matches
 * nothing (no row may be skipped), eight terms, a short term the trigram index cannot use,
 * and the detail of one submission are timed; the middle of three runs counts.
 */
const NAMES: readonly (readonly [string, string, string])[] = [
  ['Đorđe', 'Đorđević', 'Univerzitet u Čačku'],
  ['Živana', 'Živković', 'Ekonomski fakultet u Nišu'],
  ['Šćepan', 'Šćepanović', 'Institut u Žablju'],
  ['Ljiljana', 'Njegoš', 'Fakultet u Kragujevcu'],
  ['Dragan', 'Djurić', 'Visoka škola u Pančevu'],
  ['Milica', 'Čolić', 'Univerzitet u Beogradu'],
  ['Ana', 'Anić', 'Institut Anić'],
];
const STATUSES = ['new', 'open', 'returned_for_revision', 'accepted', 'rejected', 'withdrawn'];
const TYPES = ['with_paper', 'without_paper'];
const SCALE = 20_000;
const LIMIT_MS = 1_000;

describe('M4-QA-02: the submissions table with 20,000 submissions and their files (NFR-PERF-02)', () => {
  jest.setTimeout(900_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  const conferences: string[] = [];
  const timings: Record<string, number> = {};

  async function inA(sql: string, values: unknown[] = []): Promise<void> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [actors.a.organisation.id]);
      await owner.query(sql, values);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  async function plant(from: number, count: number): Promise<void> {
    const rows = [];
    for (let n = from; n < from + count; n += 1) {
      const [first, last, institution] = NAMES[n % NAMES.length] ?? ['', '', ''];
      const reference = `QP${String(n % 100).padStart(2, '0')}-${String(n).padStart(5, '0')}`;
      const title =
        n % 11 === 0 ? null : `Rad ${String(n)} o ${n % 3 === 0 ? 'učenju' : 'zadrugama'}`;
      const email = `autor.${String(n)}@autori.example.test`;
      rows.push({
        reference,
        title,
        author: `${first} ${last}`,
        institution,
        email,
        status: STATUSES[n % STATUSES.length],
        type: TYPES[n % TYPES.length],
        conference: conferences[n % conferences.length],
        search: searchTextOf(reference, title, [
          { firstName: first, lastName: last, email, institution },
        ]),
        received: new Date(Date.UTC(2027, 0, 1) + n * 37_000).toISOString(),
      });
    }
    await inA(
      `WITH f AS (SELECT f.id, v.id AS version FROM forms f JOIN form_versions v ON v.form_id = f.id LIMIT 1),
       inserted AS (
         INSERT INTO submissions (organisation_id, conference_id, form_id, form_version_id, reference,
           language, answers, title, participation_type, first_author_name, first_author_institution,
           corresponding_email, corresponding_domain, author_count, consent_text, consent_version,
           consented_at, idempotency_key, payload_hash, status, search_text, received_at)
         SELECT $1, r.conference::uuid, f.id, f.version, r.reference, 'sr', '{}', r.title, r.type,
           r.author, r.institution, r.email, 'autori.example.test', 1, 'Saglasan', 'x', now(),
           gen_random_uuid(), 'x', r.status, r.search, r.received::timestamptz
         FROM f, jsonb_to_recordset($2::jsonb) AS r(reference text, title text, author text,
           institution text, email text, status text, type text, conference text, search text,
           received text)
         RETURNING id, reference)
       INSERT INTO files (organisation_id, kind, storage_key, original_name, detected_type,
         size_bytes, sha256, scan_state, scan_flag, field_key, submission_id, attached_at)
       SELECT $1, 'submission_file', 'org/' || $1 || '/' || gen_random_uuid(), 'Rad ' || i.reference || '.docx',
         'docx', 20000, repeat('0', 64),
         CASE WHEN k = 1 AND right(i.reference, 1) IN ('0', '5') THEN 'pending' ELSE 'clean' END,
         CASE WHEN k = 2 AND right(i.reference, 2) IN ('00', '50') THEN 'macros' ELSE NULL END,
         CASE WHEN k = 1 THEN 'paper' ELSE 'biographies' END, i.id, now()
       FROM inserted i, generate_series(1, 2) AS k`,
      [actors.a.organisation.id, JSON.stringify(rows)],
    );
  }

  async function timed(label: string, path: string): Promise<unknown> {
    const times: number[] = [];
    let body: unknown;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      const response = await as(e2e, admin, 'get', path);
      times.push(performance.now() - started);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      body = response.body;
    }
    timings[label] = Math.round([...times].sort((a, b) => a - b)[1] ?? Number.POSITIVE_INFINITY);
    return body;
  }

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    admin = actors.sessions.adminA;
    for (const year of [2051, 2052, 2053]) {
      const created = await as(e2e, admin, 'post', '/api/v1/conferences').send({
        name: `Brzina ${String(year)} (izmišljeno)`,
        code: 'BR',
        editionYear: year,
      });
      conferences.push((created.body as { id: string }).id);
    }
    const form = await as(
      e2e,
      admin,
      'post',
      `/api/v1/conferences/${conferences[0] ?? ''}/forms`,
    ).send({ type: 'abstract' });
    const body = form.body as { id: string; version: number };
    await as(e2e, admin, 'post', `/api/v1/forms/${body.id}/publish`).send({
      version: body.version,
    });
    for (let from = 0; from < SCALE; from += 2_500) {
      await plant(from, 2_500);
    }
    await owner.query('ANALYZE submissions');
    await owner.query('ANALYZE files');
  });

  afterAll(async () => {
    process.stdout.write(
      `M4-QA-02 timings (ms, middle of three, limit ${String(LIMIT_MS)}):\n${Object.entries(timings)
        .map(([label, ms]) => `  ${String(ms).padStart(5)}  ${label}`)
        .join('\n')}\n`,
    );
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  it('holds 20,000 submissions with 40,000 files', async () => {
    const all = (await timed(
      'every status, the count',
      `/api/v1/submissions?status=${STATUSES.join(',')}`,
    )) as { total: number };
    expect(all.total).toBe(SCALE);
  });

  it.each([
    ['the default view, newest first', ''],
    ['page of 100', '?pageSize=100'],
    ['search djordjevic', '?q=djordjevic'],
    ['search Cyrillic Ђорђевић', `?q=${encodeURIComponent('Ђорђевић')}`],
    ['search two words', '?q=ucenju%20cacku'],
    ['search eight words', '?q=rad%20o%20ucenju%20univerzitet%20u%20cacku%20djordje%20djordjevic'],
    ['search that matches nothing', '?q=nepostojecaprijava'],
    ['search of two letters (no trigram)', '?q=dj'],
    ['search an email address', '?q=autor.19999%40autori.example.test'],
    ['search a reference', '?q=QP42-19942'],
    ['filter accepted and rejected', '?status=accepted,rejected'],
    ['filter conference and type', '?participationType=with_paper&conferenceId=CONF'],
    ['sort by title', '?sort=title&pageSize=100'],
    ['sort by institution desc', '?sort=institution&order=desc&pageSize=100'],
    ['sort by first author', '?sort=firstAuthor&pageSize=100'],
    ['sort by status', '?sort=status&pageSize=100'],
    ['sort by conference', '?sort=conference&pageSize=100'],
    ['sort by type', '?sort=participationType&pageSize=100'],
    ['sort by reference', '?sort=reference&pageSize=100'],
    [
      'the deepest page',
      '?pageSize=100&page=167&status=new,open,returned_for_revision,accepted,rejected,withdrawn',
    ],
    [
      'the deepest page sorted by title',
      '?pageSize=100&page=200&sort=title&status=new,open,returned_for_revision,accepted,rejected,withdrawn',
    ],
    ['search and filter and sort', '?q=zivkovic&status=open&sort=title&order=desc'],
  ])('%s answers within one second', async (label, query) => {
    const path = `/api/v1/submissions${query.replace('CONF', conferences[1] ?? '')}`;
    await timed(label, path);
    expect({ label, ms: timings[label], under: (timings[label] ?? Infinity) < LIMIT_MS }).toEqual({
      label,
      ms: timings[label],
      under: true,
    });
  });

  it('a row of the table shows its file signs: pending and flagged', async () => {
    const page = (await timed(
      'signs, references ending 00',
      `/api/v1/submissions?q=QP00-&pageSize=100&status=${STATUSES.join(',')}`,
    )) as {
      items: { reference: string; fileSigns: { flags: string[]; scanPending: boolean } }[];
    };
    const flagged = page.items.find((item) => item.reference.endsWith('00'));
    expect(flagged?.fileSigns).toEqual({ flags: ['macros'], scanPending: true });
  });
});
