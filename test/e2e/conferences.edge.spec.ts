import type { Client } from 'pg';
import { type Actors, as, createActors, type SignedIn, signIn } from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * E2-01 (ADR-07, SEC-A-08, ST-30, FR-CONF-01), through the API on the configuration of a
 * server: the listed sites are "kept as their origin only", and "nothing of that kind may
 * reach a header" - 0.3.0 builds `frame-ancestors` from the stored origins. The check
 * looks at the text that was typed; the URL parser then decodes `%3B` and folds a
 * full-width `；`, and both come out as `;` in the stored origin.
 */
describe('listed sites of a conference, through the API (E2-01)', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;
  let year = 2050;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    admin = await signIn(e2e, actors.a.admin);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  it.each([
    'https://moj-sajt.example.test%3Bscript-src',
    'https://a%3Bscript-src.example.test',
    'https://a%2Cb.example.test',
    'https://a%27b.example.test',
    'https://a；script-src.example.test',
  ])('refuses %j when a conference is created', async (site) => {
    year += 1;
    const response = await as(e2e, admin, 'post', '/api/v1/conferences').send({
      name: 'Sajtovi (izmišljeno)',
      code: 'SJ',
      editionYear: year,
      listedSites: [site],
    });
    expect(response.status).toBe(400);
  });

  it('keeps no origin with a semicolon or a comma in it, on a change either', async () => {
    year += 1;
    const created = await as(e2e, admin, 'post', '/api/v1/conferences').send({
      name: 'Sajtovi (izmišljeno)',
      code: 'SJ',
      editionYear: year,
    });
    expect(created.status).toBe(201);
    const conference = created.body as { id: string; version: number };
    const changed = await as(e2e, admin, 'patch', `/api/v1/conferences/${conference.id}`).send({
      listedSites: ['https://a%3Bb.example.test', 'https://c%2Cd.example.test'],
      version: conference.version,
    });
    const stored = (changed.body as { listedSites?: string[] }).listedSites ?? [];
    expect(stored.filter((origin) => /[;,'"\s]/.test(origin))).toEqual([]);
  });

  it('refuses https://localhost on the configuration of a server (SEC-M2-12)', async () => {
    year += 1;
    const response = await as(e2e, admin, 'post', '/api/v1/conferences').send({
      name: 'Sajtovi (izmišljeno)',
      code: 'SJ',
      editionYear: year,
      listedSites: ['https://localhost:8443'],
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({ errors: [{ path: 'listedSites[0]', code: 'site_loopback' }] }),
    );
  });

  it.each([
    ['a semicolon', '{"https://a.example.test;script-src *"}'],
    ['a path', '{"https://a.example.test/forms"}'],
    ['upper case', '{"HTTPS://A.EXAMPLE.TEST"}'],
    ['an empty entry', '{""}'],
    ['a NULL entry', '{NULL}'],
    ['21 entries', `{${Array.from({ length: 21 }, (_, n) => `"https://s${String(n)}.example.test"`).join(',')}}`],
  ])('the database itself refuses a stored site list with %s (SEC-M2-12)', async (_name, sites) => {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [actors.a.organisation.id]);
      await expect(
        owner.query(
          `INSERT INTO conferences (organisation_id, name, code, listed_sites) VALUES ($1, 'Baza (izmišljeno)', 'DB', $2::text[])`,
          [actors.a.organisation.id, sites],
        ),
      ).rejects.toThrow(/conferences_listed_sites_are_origins/);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
