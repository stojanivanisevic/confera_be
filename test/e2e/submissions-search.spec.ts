import type { Client } from 'pg';
import { searchTextOf } from '../../src/modules/submissions/search';
import { as, createActors, type Actors, type SignedIn } from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * The submissions table (M4-BE-04; FR-SUB-02, FR-SUB-03, NFR-PERF-02): the search without
 * diacritics on a Serbian name set with đ, every filter alone and combined, the fixed orders,
 * the pages, and a search or filter within one second with 20,000 submissions stored.
 *
 * The rows are planted by the owner inside organisation A, through row-level security, with
 * the search text the application writes (search.ts); organisation B has its own, which A
 * never sees.
 */
const NAMES: readonly (readonly [string, string, string])[] = [
  ['Đorđe', 'Đorđević', 'Univerzitet u Čačku'],
  ['Živana', 'Živković', 'Ekonomski fakultet u Nišu'],
  ['Šćepan', 'Šćepanović', 'Institut u Žablju'],
  ['Ljiljana', 'Njegoš', 'Fakultet u Kragujevcu'],
  ['Dragan', 'Djurić', 'Visoka škola u Pančevu'],
  ['Milica', 'Čolić', 'Univerzitet u Beogradu'],
];
const STATUSES = ['new', 'open', 'returned_for_revision', 'accepted', 'rejected', 'withdrawn'];
const TYPES = ['with_paper', 'without_paper'];
const SCALE = 20_000;

describe('the submissions table (M4-BE-04, NFR-PERF-02)', () => {
  jest.setTimeout(600_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  const conferences: string[] = [];

  async function plant(organisationId: string, count: number, offset: number): Promise<void> {
    const rows: unknown[][] = [];
    for (let n = offset; n < offset + count; n += 1) {
      const [first, last, institution] = NAMES[n % NAMES.length] ?? NAMES[0] ?? ['', '', ''];
      const reference = `SR${String(n % 100).padStart(2, '0')}-${String(n).padStart(5, '0')}`;
      const title = `Rad broj ${String(n)} o ${n % 3 === 0 ? 'učenju' : 'zadrugama'}`;
      const email = `autor.${String(n)}@autori.example.test`;
      rows.push([
        reference,
        title,
        `${first} ${last}`,
        institution,
        email,
        STATUSES[n % STATUSES.length],
        TYPES[n % TYPES.length],
        conferences[n % conferences.length],
        searchTextOf(reference, title, [{ firstName: first, lastName: last, email, institution }]),
        new Date(Date.UTC(2027, 0, 1) + n * 60_000).toISOString(),
      ]);
    }
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
      const form = await owner.query<{ id: string; version: string }>(
        `SELECT f.id, v.id AS version FROM forms f JOIN form_versions v ON v.form_id = f.id LIMIT 1`,
      );
      const { id: formId, version } = form.rows[0] ?? { id: '', version: '' };
      // One statement for many rows: the shape of a real row, the columns the table reads.
      await owner.query(
        `INSERT INTO submissions (organisation_id, conference_id, form_id, form_version_id, reference,
           language, answers, title, participation_type, first_author_name, first_author_institution,
           corresponding_email, corresponding_domain, author_count, consent_text, consent_version,
           consented_at, idempotency_key, payload_hash, status, search_text, received_at)
         SELECT $1, r.conference::uuid, $2, $3, r.reference, 'sr', '{}', r.title, r.type, r.author,
           r.institution, r.email, 'autori.example.test', 1, 'Saglasan', 'x', now(),
           gen_random_uuid(), 'x', r.status, r.search, r.received::timestamptz
         FROM jsonb_to_recordset($4::jsonb) AS r(reference text, title text, author text,
           institution text, email text, status text, type text, conference text, search text,
           received text)`,
        [
          organisationId,
          formId,
          version,
          JSON.stringify(
            rows.map(
              ([
                reference,
                title,
                author,
                institution,
                email,
                status,
                type,
                conference,
                search,
                received,
              ]) => ({
                reference,
                title,
                author,
                institution,
                email,
                status,
                type,
                conference,
                search,
                received,
              }),
            ),
          ),
        ],
      );
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  async function list(query: string): Promise<{
    items: {
      reference: string;
      firstAuthor: string;
      status: string;
      conference: { id: string };
      participationType: string;
      receivedAt: string;
    }[];
    total: number;
  }> {
    const response = await as(e2e, admin, 'get', `/api/v1/submissions${query}`);
    expect({ query, status: response.status }).toEqual({ query, status: 200 });
    return response.body as never;
  }

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    admin = actors.sessions.adminA;
    for (const year of [2041, 2042]) {
      const created = await as(e2e, admin, 'post', '/api/v1/conferences').send({
        name: `Pretraga ${String(year)} (izmišljeno)`,
        code: 'PR',
        editionYear: year,
      });
      conferences.push((created.body as { id: string }).id);
    }
    // A form with a version for the planted rows.
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
    await plant(actors.a.organisation.id, 600, 0);
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  it.each([
    ['Djordjevic', 'Đorđević'],
    ['djordje', 'Đorđević'],
    ['Đorđević', 'Đorđević'],
    ['Zivkovic', 'Živković'],
    ['Živković', 'Živković'],
    ['SCEPANOVIC', 'Šćepanović'],
    ['šćepanović', 'Šćepanović'],
    ['Ђорђевић', 'Đorđević'],
    ['Djuric', 'Djurić'],
    ['colic', 'Čolić'],
  ])('a search for %s finds %s and only them', async (query, last) => {
    const found = await list(
      `?q=${encodeURIComponent(query)}&status=${STATUSES.join(',')}&pageSize=100`,
    );
    expect(found.total).toBe(100);
    expect(found.items.every((item) => item.firstAuthor.endsWith(last))).toBe(true);
  });

  it('searches the institution, the email, the reference and the title, every word', async () => {
    expect((await list(`?q=cacku&status=${STATUSES.join(',')}`)).total).toBe(100);
    expect(
      (await list('?q=autor.17%40autori.example.test&status=withdrawn')).items.map(
        (item) => item.reference,
      ),
    ).toEqual(['SR17-00017']);
    expect((await list('?q=SR04-00004')).total).toBe(1);
    // Every sixth row is of Čačak, and each of them is about learning (a multiple of three).
    expect((await list(`?q=ucenju%20cacku&status=${STATUSES.join(',')}`)).total).toBe(100);
  });

  it('filters alone and combined return exactly the matching rows, and the default leaves the withdrawn out', async () => {
    expect((await list('')).total).toBe(500);
    expect((await list('?status=withdrawn')).total).toBe(100);
    expect((await list('?status=new,open')).total).toBe(200);
    expect(
      (await list(`?conferenceId=${conferences[0] ?? ''}&status=${STATUSES.join(',')}`)).total,
    ).toBe(300);
    expect((await list('?participationType=with_paper&status=accepted')).total).toBe(0);
    expect((await list('?participationType=without_paper&status=accepted')).total).toBe(100);
    const combined = await list(
      `?conferenceId=${conferences[1] ?? ''}&status=open&participationType=without_paper&q=zivkovic`,
    );
    expect(
      combined.items.every(
        (item) =>
          item.status === 'open' &&
          item.conference.id === conferences[1] &&
          item.firstAuthor.endsWith('Živković'),
      ),
    ).toBe(true);
    expect(combined.total).toBe(100);
    // Another organisation's rows are never in the table.
    const other = await as(e2e, actors.sessions.adminB, 'get', '/api/v1/submissions?q=djordjevic');
    expect((other.body as { total: number }).total).toBe(0);
  });

  it('sorts by the fixed map only, and the pages neither overlap nor leave a gap', async () => {
    const references = await list('?sort=reference&order=asc&pageSize=100&status=new');
    const sorted = [...references.items.map((item) => item.reference)].sort();
    expect(references.items.map((item) => item.reference)).toEqual(sorted);
    const newest = await list('?pageSize=5');
    expect(newest.items.map((item) => item.receivedAt)).toEqual(
      [...newest.items.map((item) => item.receivedAt)].sort().reverse(),
    );
    const seen = new Set<string>();
    for (let page = 1; page <= 5; page += 1) {
      for (const item of (await list(`?sort=firstAuthor&page=${String(page)}&pageSize=100`))
        .items) {
        seen.add(item.reference);
      }
    }
    expect(seen.size).toBe(500);
    for (const bad of [
      '?sort=organisation_id',
      '?sort=title;drop',
      '?order=up',
      '?status=deleted',
      '?pageSize=101',
    ]) {
      const response = await as(e2e, admin, 'get', `/api/v1/submissions${bad}`);
      expect({ bad, status: response.status }).toEqual({ bad, status: 400 });
    }
  });

  it('NFR-PERF-02: answers a search or a filter within one second with 20,000 submissions stored', async () => {
    await plant(actors.a.organisation.id, SCALE - 600, 600);
    await owner.query('ANALYZE submissions');
    const queries = [
      '',
      '?q=djordjevic',
      '?q=ucenju%20cacku',
      '?status=accepted,rejected&sort=title',
      `?conferenceId=${conferences[1] ?? ''}&participationType=with_paper&sort=firstAuthor&order=desc`,
      '?q=SR42-19942',
      '?page=150&pageSize=100&sort=reference',
    ];
    const timings: Record<string, number> = {};
    for (const query of queries) {
      // The middle of three: the machine may be busy, a person waits for the usual answer.
      const times: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        await list(query);
        times.push(performance.now() - started);
      }
      timings[query] = [...times].sort((a, b) => a - b)[1] ?? Number.POSITIVE_INFINITY;
    }
    expect((await list(`?status=${STATUSES.join(',')}`)).total).toBe(SCALE);
    for (const [query, ms] of Object.entries(timings)) {
      expect({ query, ms, under: ms < 1000 }).toEqual({ query, ms, under: true });
    }
  });
});
