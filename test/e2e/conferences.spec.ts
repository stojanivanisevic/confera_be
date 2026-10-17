import type { Client } from 'pg';
import { type Actors, as, createActors, type SignedIn, signIn } from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * Conferences (M2-BE-09; FR-CONF-01 to 04; ST-30) and the templates read API (M2-BE-10),
 * on the application as on a server.
 */
describe('conferences and templates', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let adminA: SignedIn;
  let adminB: SignedIn;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    adminA = await signIn(e2e, actors.a.admin);
    adminB = await signIn(e2e, actors.b.admin);
    await new Factories(owner).templates(actors.a.organisation.id);
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  const create = (body: object, who = adminA) =>
    as(e2e, who, 'post', '/api/v1/conferences').send(body);

  it('creates a conference as a draft, with its listed sites as origins (FR-CONF-01, ST-30)', async () => {
    const response = await create({
      name: 'ITEMA 2027 (izmišljeno)',
      code: 'IT',
      editionYear: 2027,
      startsOn: '2027-10-14',
      endsOn: '2027-10-16',
      venue: 'Beograd',
      listedSites: ['HTTPS://WWW.ITEMA-CONFERENCE.COM/', 'https://www.itema-conference.com'],
      languages: ['en', 'sr'],
      timeZone: 'Europe/Belgrade',
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(
      expect.objectContaining({
        state: 'draft',
        code: 'IT',
        startsOn: '2027-10-14',
        listedSites: ['https://www.itema-conference.com'],
        version: 1,
      }),
    );
  });

  it.each([
    ['a wildcard', 'https://*.itema-conference.com', 'site_wildcard'],
    ['a path', 'https://www.itema-conference.com/forms', 'site_path'],
    ['http:', 'http://www.itema-conference.com', 'site_scheme'],
    ['a space', 'https://a.example.test https://b.example.test', 'site_forbidden_character'],
    ['a semicolon', 'https://a.example.test;', 'site_forbidden_character'],
    ['a user part', 'https://user@www.itema-conference.com', 'site_user_part'],
  ])('refuses a listed site with %s (ST-30)', async (_name, site, code) => {
    const response = await create({ name: 'X (izmišljeno)', code: 'XX', listedSites: [site] });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'validation_failed',
        errors: [{ path: 'listedSites[0]', code }],
      }),
    );
  });

  it('refuses a 21st listed site (ST-30)', async () => {
    const sites = Array.from(
      { length: 21 },
      (_, index) => `https://s${String(index)}.example.test`,
    );
    const response = await create({ name: 'X (izmišljeno)', code: 'XX', listedSites: sites });
    expect(response.status).toBe(400);
  });

  it('refuses an unknown time zone, a code that is not two capitals, and an end before the start', async () => {
    for (const body of [
      { timeZone: 'Europe/Novi_Sad' },
      { code: 'it' },
      { code: 'ITE' },
      { startsOn: '2027-10-16', endsOn: '2027-10-14' },
    ]) {
      expect((await create({ name: 'X (izmišljeno)', code: 'XX', ...body })).status).toBe(400);
    }
  });

  it('refuses the same code and edition twice, also without an edition', async () => {
    expect((await create({ name: 'A', code: 'ER', editionYear: 2027 })).status).toBe(201);
    expect((await create({ name: 'B', code: 'ER', editionYear: 2027 })).body).toEqual(
      expect.objectContaining({ code: 'conference_code_taken' }),
    );
    expect((await create({ name: 'C', code: 'EM' })).status).toBe(201);
    expect((await create({ name: 'D', code: 'EM' })).status).toBe(409);
    // Another organisation has codes of its own.
    expect((await create({ name: 'E', code: 'EM' }, adminB)).status).toBe(201);
  });

  it('changes state as FR-CONF-04 allows; an archived conference is read-only', async () => {
    const created = (await create({ name: 'LIMEN (izmišljeno)', code: 'LI' })).body as {
      id: string;
      version: number;
    };
    const state = (value: string, version: number) =>
      as(e2e, adminA, 'post', `/api/v1/conferences/${created.id}/state`).send({
        state: value,
        version,
      });
    const opened = await state('open', created.version);
    expect(opened.body).toEqual(expect.objectContaining({ state: 'open', version: 2 }));
    expect((await state('archived', 2)).body).toEqual(
      expect.objectContaining({ code: 'state_change_not_allowed' }),
    );
    expect((await state('closed', 2)).body).toEqual(expect.objectContaining({ state: 'closed' }));
    expect((await state('archived', 3)).body).toEqual(
      expect.objectContaining({ state: 'archived' }),
    );
    const edit = await as(e2e, adminA, 'patch', `/api/v1/conferences/${created.id}`).send({
      name: 'Y',
      version: 4,
    });
    expect(edit.body).toEqual(expect.objectContaining({ code: 'conference_archived' }));
    expect((await state('open', 4)).status).toBe(409);
  });

  it('refuses a change made on an older version', async () => {
    const created = (await create({ name: 'AI-SMART (izmišljeno)', code: 'AI' })).body as {
      id: string;
    };
    const patch = (version: number) =>
      as(e2e, adminA, 'patch', `/api/v1/conferences/${created.id}`).send({
        venue: 'Novi Sad',
        version,
      });
    expect((await patch(1)).status).toBe(200);
    expect((await patch(1)).body).toEqual(expect.objectContaining({ code: 'version_conflict' }));
  });

  it('copies a conference with its settings and templates, not its dates; the copy is its own (FR-CONF-03)', async () => {
    const source = (
      await create({
        name: 'EMAN 2027 (izmišljeno)',
        code: 'EM',
        editionYear: 2027,
        startsOn: '2027-03-01',
        endsOn: '2027-03-02',
        listedSites: ['https://eman-conference.org'],
        languages: ['en', 'sr'],
      })
    ).body as { id: string };
    await new Factories(owner).templates(actors.a.organisation.id, source.id);
    const copy = await as(e2e, adminA, 'post', `/api/v1/conferences/${source.id}/copy`).send({
      name: 'EMAN 2028 (izmišljeno)',
      editionYear: 2028,
    });
    expect(copy.status).toBe(201);
    expect(copy.body).toEqual(
      expect.objectContaining({
        code: 'EM',
        editionYear: 2028,
        state: 'draft',
        startsOn: null,
        endsOn: null,
        listedSites: ['https://eman-conference.org'],
        languages: ['en', 'sr'],
      }),
    );
    const copyId = (copy.body as { id: string }).id;
    const templates = (id: string) =>
      as(e2e, adminA, 'get', `/api/v1/mail-templates?conferenceId=${id}`);
    const original = (await templates(source.id)).body as {
      items: { type: string; language: string }[];
    };
    const copied = (await templates(copyId)).body as {
      items: { type: string; language: string }[];
    };
    expect(copied.items.map(({ type, language }) => `${type}/${language}`)).toEqual(
      original.items.map(({ type, language }) => `${type}/${language}`),
    );
    // Eight types in two languages (the confirmation of a submission came with 0.3.0).
    expect(copied.items.length).toBe(16);
    await as(e2e, adminA, 'patch', `/api/v1/conferences/${copyId}`).send({
      venue: 'Kragujevac',
      version: 1,
    });
    expect((await as(e2e, adminA, 'get', `/api/v1/conferences/${source.id}`)).body).toEqual(
      expect.objectContaining({ venue: null }),
    );
  });

  it('shows no conference of A to B, and refuses a mail server of B on a conference of A', async () => {
    const listB = (await as(e2e, adminB, 'get', '/api/v1/conferences')).body as {
      items: { name: string }[];
    };
    expect(listB.items.map(({ name }) => name)).toEqual(['E']);
    const response = await create({
      name: 'F',
      code: 'FF',
      mailServerId: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({ errors: [{ path: 'mailServerId', code: 'unknownMailServer' }] }),
    );
  });

  describe('the templates (M2-BE-10)', () => {
    it('gives the placeholder catalogue of every type', async () => {
      const catalogue = (await as(e2e, adminA, 'get', '/api/v1/mail-templates/catalogue')).body as {
        types: { type: string; placeholders: string[]; carriesLink: boolean }[];
        languages: string[];
      };
      expect(catalogue.languages).toEqual(['en', 'sr']);
      expect(catalogue.types.find(({ type }) => type === 'invitation')).toEqual({
        type: 'invitation',
        placeholders: ['recipientName', 'organisationName', 'inviterName', 'expiresIn'],
        conditions: [],
        carriesLink: true,
      });
    });

    it("lists the organisation's templates in both languages, and reads one", async () => {
      const list = (await as(e2e, adminA, 'get', '/api/v1/mail-templates?type=invitation'))
        .body as {
        items: { id: string; language: string; body: { type: string } }[];
      };
      expect(list.items.map(({ language }) => language)).toEqual(['en', 'sr']);
      const one = await as(e2e, adminA, 'get', `/api/v1/mail-templates/${list.items[0]?.id ?? ''}`);
      expect(one.body).toEqual(expect.objectContaining({ type: 'invitation', conferenceId: null }));
      expect((one.body as { body: { type: string } }).body.type).toBe('doc');
      expect(
        (await as(e2e, adminB, 'get', `/api/v1/mail-templates/${list.items[0]?.id ?? ''}`)).status,
      ).toBe(404);
    });
  });
});
