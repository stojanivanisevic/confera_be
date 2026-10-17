import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type request from 'supertest';
import { as, type SignedIn } from './actors';
import { type E2eApp, PUBLIC_HOST } from './e2e-app';

/**
 * Forms for the end-to-end tests (M3): a conference that is open for submissions with an
 * abstract form published, and the calls of the public page, made as Confera's own page
 * makes them (the public host, its exact Origin, `Sec-Fetch-Site: same-origin`).
 */
let year = 2040;
const codes = 'ABCDEFGHJKLMNPRSTUVWXYZ';
let code = 0;

export interface OpenForm {
  readonly conferenceId: string;
  readonly formId: string;
  readonly slug: string;
  readonly code: string;
  readonly editionYear: number;
}

export async function openForm(
  e2e: E2eApp,
  admin: SignedIn,
  options: {
    configuration?: Record<string, unknown>;
    deadline?: string | null;
    listedSites?: string[];
    publicationTermsUrl?: string;
  } = {},
): Promise<OpenForm> {
  year += 1;
  const conferenceCode = `Q${codes[code % codes.length] ?? 'Q'}`;
  code += 1;
  const created = await as(e2e, admin, 'post', '/api/v1/conferences').send({
    name: `Probna konferencija ${String(year)} (izmišljeno)`,
    code: conferenceCode,
    editionYear: year,
    languages: ['en', 'sr'],
    listedSites: options.listedSites ?? ['https://www.konferencija.example.test'],
    ...(options.publicationTermsUrl === undefined
      ? {}
      : { publicationTermsUrl: options.publicationTermsUrl }),
  });
  if (created.status !== 201) {
    throw new Error(`conference: ${String(created.status)} ${JSON.stringify(created.body)}`);
  }
  const conference = created.body as { id: string; version: number };
  const opened = await as(e2e, admin, 'post', `/api/v1/conferences/${conference.id}/state`).send({
    state: 'open',
    version: conference.version,
  });
  if (opened.status !== 201 && opened.status !== 200) {
    throw new Error(`open: ${String(opened.status)} ${JSON.stringify(opened.body)}`);
  }
  if (options.deadline !== null) {
    const deadline = await as(
      e2e,
      admin,
      'put',
      `/api/v1/conferences/${conference.id}/deadlines/abstract_submission`,
    ).send({ endsOn: options.deadline ?? '2099-12-31' });
    if (deadline.status !== 200) {
      throw new Error(`deadline: ${String(deadline.status)} ${JSON.stringify(deadline.body)}`);
    }
  }
  const form = await as(e2e, admin, 'post', `/api/v1/conferences/${conference.id}/forms`).send({
    type: 'abstract',
  });
  if (form.status !== 201) {
    throw new Error(`form: ${String(form.status)} ${JSON.stringify(form.body)}`);
  }
  let current = form.body as { id: string; slug: string; version: number };
  if (options.configuration !== undefined) {
    const draft = await as(e2e, admin, 'put', `/api/v1/forms/${current.id}/draft`).send({
      configuration: options.configuration,
      version: current.version,
    });
    if (draft.status !== 200) {
      throw new Error(`draft: ${String(draft.status)} ${JSON.stringify(draft.body)}`);
    }
    current = draft.body as typeof current;
  }
  const published = await as(e2e, admin, 'post', `/api/v1/forms/${current.id}/publish`).send({
    version: current.version,
  });
  if (published.status !== 201) {
    throw new Error(`publish: ${String(published.status)} ${JSON.stringify(published.body)}`);
  }
  return {
    conferenceId: conference.id,
    formId: current.id,
    slug: current.slug,
    code: conferenceCode,
    editionYear: year,
  };
}

/** A request of Confera's own form page, from a client address of its own. */
export function page(
  e2e: E2eApp,
  method: 'get' | 'post',
  path: string,
  address = '203.0.113.10',
): request.Test {
  const call = e2e
    .http()
    [method](path)
    .set('Host', PUBLIC_HOST)
    .set('X-Forwarded-For', address)
    .set('Sec-Fetch-Site', 'same-origin');
  return method === 'post' ? call.set('Origin', e2e.config.origins.public) : call;
}

let addresses = 0;
/** A client address no other test uses, so that the limits per address do not meet. */
export function freshAddress(): string {
  addresses += 1;
  return `198.51.${String(Math.floor(addresses / 250) % 250)}.${String((addresses % 250) + 1)}`;
}

export async function tokenFor(
  e2e: E2eApp,
  slug: string,
  address: string,
): Promise<{ formToken: string; proofOfWork: { challenge: string; difficulty: number } | null }> {
  const response = await page(e2e, 'post', `/public/v1/forms/${slug}/tokens`, address)
    .set('Content-Type', 'application/json')
    .send('{}');
  if (response.status !== 201) {
    throw new Error(`token: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response.body as {
    formToken: string;
    proofOfWork: { challenge: string; difficulty: number } | null;
  };
}

/** Moves the issue of every token of an organisation back by a minute: past the minimum fill time. */
export async function ageTokens(owner: Client, organisationId: string): Promise<void> {
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
    await owner.query("UPDATE form_tokens SET issued_at = issued_at - interval '1 minute'");
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

/** A complete abstract submission with a paper, paid by the author. */
export function abstractAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participationType: 'with_paper',
    authors: [
      {
        firstName: 'Živana',
        lastName: 'Đorđević',
        institution: 'Univerzitet u Izmišljenom Gradu',
        email: `zivana.${randomUUID().slice(0, 8)}@autori.example.test`,
        phone: '+381 11 123 4567',
      },
    ],
    title: 'Učenje na daljinu u malim školama',
    abstract: 'Kratak apstrakt o učenju na daljinu.',
    keywords: 'učenje, škole',
    publication: 'proceedings',
    membership: 'no',
    attendance: 'in_person',
    discountClaim: 'no',
    payer: 'individual',
    billingAddress: 'Izmišljena 1, Beograd',
    paymentMethod: 'bank_wire',
    consent: true,
    ...overrides,
  };
}

export function submit(
  e2e: E2eApp,
  slug: string,
  token: string,
  body: Record<string, unknown>,
  options: { address?: string; key?: string } = {},
): request.Test {
  return page(e2e, 'post', `/public/v1/forms/${slug}/submissions`, options.address)
    .set('Content-Type', 'application/json')
    .set('X-Form-Token', token)
    .set('Idempotency-Key', options.key ?? randomUUID())
    .send(JSON.stringify(body));
}

/** Rows of a table inside an organisation, as the owner (the tests' window on the database). */
export async function inOrganisation<T extends Record<string, unknown>>(
  owner: Client,
  organisationId: string,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
    const result = await owner.query<T>(sql, values);
    await owner.query('COMMIT');
    return result.rows;
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}
