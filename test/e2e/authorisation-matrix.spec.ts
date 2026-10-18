import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { repoRoot } from '../support/run-node';
import {
  type ActorName,
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * The authorisation matrix (M2-BE-01, M2-QA-01; ADR-05, ADR-24; FR-USR-01, NFR-SEC-01):
 * generated from the committed OpenAPI file, every operation of the admin API for five
 * actors. The operation's own declaration (`x-confera-access`: a permission, or public)
 * says what each actor must get:
 *
 *   anonymous   401 on every route with a permission; never 401 or 403 on a public one
 *   endedA      401 (a session that was ended on the server is nobody)
 *   reviewerA   403 on every route whose permission the reviewer's role does not hold
 *   adminB      404 on every route that names an object of A: another organisation's
 *               data is not found, not forbidden (row-level security)
 *   adminA      never 401, 403 or 404 on the objects of A (a 400 or 409 may follow from
 *               the empty body sent here; what matters is that the door opened)
 *
 * The password asked again (`x-confera-fresh-password`) is a 403 of its own for an admin
 * who has not given it, so the matrix gives it first.
 */
interface Operation {
  readonly id: string;
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
  readonly permission: string | null;
  readonly freshPassword: boolean;
  readonly hasBody: boolean;
}

interface OpenApiDocument {
  readonly paths: Record<string, Record<string, Record<string, unknown>>>;
}

const document = JSON.parse(
  readFileSync(join(repoRoot, 'openapi', 'openapi.json'), 'utf8'),
) as OpenApiDocument;

const OPERATIONS: Operation[] = Object.entries(document.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, operation]) => {
      const access = operation['x-confera-access'] as { permission?: string; public?: boolean };
      return {
        id: String(operation.operationId),
        method: method as Operation['method'],
        path,
        permission: access.permission ?? null,
        freshPassword: operation['x-confera-fresh-password'] === true,
        hasBody: operation.requestBody !== undefined,
      };
    }),
);

/**
 * A body that passes the validation of each operation that takes one, so that the answer
 * comes from the authorisation and the object, not from an empty body. A version that no
 * row has (99) leaves every object as it is (409 version_conflict for the owner, 404 for
 * a stranger, who never gets that far).
 */
const SAMPLE_BODIES: Readonly<Record<string, () => object>> = {
  signIn: () => ({ email: 'nobody@a.example.test', password: 'invented-wrong-one-123' }),
  changePassword: () => ({
    currentPassword: 'invented-wrong-one-123',
    newPassword: 'invented-Breza-Most-Polje-7',
    newPasswordRepeat: 'invented-Breza-Most-Polje-7',
  }),
  changeEmail: () => ({ password: 'invented-wrong-one-123', newEmail: 'nobody@a.example.test' }),
  confirmPassword: () => ({ password: 'invented-wrong-one-123' }),
  requestReset: () => ({ email: 'nobody@a.example.test' }),
  completeReset: () => ({
    password: 'invented-Breza-Most-Polje-7',
    passwordRepeat: 'invented-Breza-Most-Polje-7',
  }),
  acceptInvitation: () => ({
    password: 'invented-Breza-Most-Polje-7',
    passwordRepeat: 'invented-Breza-Most-Polje-7',
  }),
  inviteUser: () => ({
    email: `matrix.${randomBytes(4).toString('hex')}@a.example.test`,
    displayName: 'Matrica Probna',
    role: 'reviewer',
  }),
  updateUser: () => ({ displayName: 'Matrica Probna', version: 99 }),
  changeRole: () => ({ role: 'reviewer', version: 99 }),
  deactivateUser: () => ({ version: 99 }),
  reactivateUser: () => ({ version: 99 }),
  updateOrganisation: () => ({ version: 99 }),
  createMailServer: () => ({
    name: 'Matrica',
    host: 'smtp.a.example.test',
    port: 587,
    tlsMode: 'starttls',
    fromAddress: 'office@a.example.test',
    fromName: 'Matrica Probna',
  }),
  updateMailServer: () => ({ name: 'Matrica', version: 99 }),
  sendTestMessage: () => ({ to: 'nobody@a.example.test' }),
  createConference: () => ({
    name: 'Matrica (izmišljeno)',
    code: 'ZZ',
    editionYear: 2000 + ((randomBytes(1)[0] ?? 0) % 100),
  }),
  updateConference: () => ({ name: 'Matrica (izmišljeno)', version: 99 }),
  changeConferenceState: () => ({ state: 'open', version: 99 }),
  copyConference: () => ({ name: 'Matrica kopija (izmišljeno)', editionYear: 2100 }),
  createForm: () => ({ type: 'abstract' }),
  saveFormDraft: () => ({ configuration: {}, version: 99 }),
  publishForm: () => ({ version: 99 }),
  setFormBreaker: () => ({ breakerPerHour: 30, breakerPerDay: 200, version: 99 }),
  setDeadline: () => ({ endsOn: '2099-12-31', version: 99 }),
  releaseHeldMail: () => ({ ids: ['00000000-0000-4000-8000-000000000000'] }),
  setOrganisationBreaker: () => ({ perHour: 30, perDay: 200, version: 99 }),
  discardHeldMail: () => ({ ids: ['00000000-0000-4000-8000-000000000000'] }),
  previewStatusEmail: () => ({ action: 'open' }),
  changeSubmissionStatus: () => ({ action: 'open', version: 99 }),
  addSubmissionNote: () => ({ body: 'Matrica (izmišljeno)' }),
  editSubmission: () => ({ version: 99, answers: {} }),
  createMailTemplate: () => ({
    type: 'submission_opened',
    language: 'sr',
    subject: { type: 'subject', children: [{ type: 'text', text: 'Matrica' }] },
    body: { type: 'doc', children: [] },
  }),
  updateMailTemplate: () => ({
    subject: { type: 'subject', children: [{ type: 'text', text: 'Matrica' }] },
    body: { type: 'doc', children: [] },
    version: 99,
  }),
  previewMailTemplate: () => ({
    type: 'invitation',
    language: 'en',
    subject: { type: 'subject', children: [{ type: 'text', text: 'Matrica' }] },
    body: { type: 'doc', children: [] },
  }),
  setStatusEmails: () => ({ types: [], version: 99 }),
  changePaymentDetails: () => ({
    rsdAccount: null,
    eurIban: null,
    eurSwift: null,
    eurBankName: null,
    paypalPayee: null,
    version: 99,
  }),
};

/** The query of the operations that take one. */
const SAMPLE_QUERIES: Readonly<Record<string, string>> = {
  removeUser: '?version=99',
  deleteMailServer: '?version=99',
};

/**
 * The codes with which the door stays shut. An operation that answers 401 or 403 with a
 * code of its own (sign_in_failed for a wrong password, password_incorrect) has opened
 * its door and judged what came in.
 */
const REFUSALS = new Set([
  'unauthenticated',
  'forbidden',
  'not_found',
  'csrf_refused',
  'origin_refused',
  'password_confirmation_required',
]);

/** What a response says about the door: its status and its code. */
function verdict(response: { status: number; body: unknown }): { status: number; code: string } {
  return { status: response.status, code: (response.body as { code?: string }).code ?? '' };
}

/**
 * One object of each kind that a path names, in organisation A, written as the owner role
 * inside the organisation: a mail server, a conference, a template and a mail-log entry.
 * Paths of users take the reviewer of A.
 */
/** The file of the submission of A (a path's `{fileId}`). */
let file = '';

async function objectsOfA(
  owner: Client,
  organisationId: string,
  publisherId: string,
): Promise<Record<string, string>> {
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
    const one = async (sql: string, values: unknown[]) =>
      (await owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? '';
    const server = await one(
      `INSERT INTO mail_servers (organisation_id, name, host, port, tls_mode, from_address, from_name)
       VALUES ($1, 'Matrica', 'smtp.a.example.test', 587, 'starttls', 'office@a.example.test', 'Matrica') RETURNING id`,
      [organisationId],
    );
    const conference = await one(
      `INSERT INTO conferences (organisation_id, name, code) VALUES ($1, 'Matrica (izmišljeno)', 'MX') RETURNING id`,
      [organisationId],
    );
    const template = await one(
      `INSERT INTO mail_templates (organisation_id, type, language, subject, body)
       VALUES ($1, 'test_message', 'en', '{"type":"subject","children":[]}', '{"type":"doc","children":[]}') RETURNING id`,
      [organisationId],
    );
    const message = await one(
      `INSERT INTO mail_outbox (organisation_id, unique_key, kind, recipient_address, status)
       VALUES ($1, 'matrix', 'test_message', 'nobody@a.example.test', 'sent') RETURNING id`,
      [organisationId],
    );
    const entry = await one(
      `INSERT INTO mail_log (organisation_id, message_id, recipient, kind, language, attempt, result)
       VALUES ($1, $2, 'nobody@a.example.test', 'test_message', 'en', 1, 'sent') RETURNING id`,
      [organisationId, message],
    );
    const form = await one(
      `INSERT INTO forms (organisation_id, conference_id, type, public_key, configuration)
       VALUES ($1, $2, 'abstract', 'matrixformaaaaaa', '{}') RETURNING id`,
      [organisationId, conference],
    );
    const version = await one(
      `INSERT INTO form_versions (organisation_id, form_id, number, definition, published_by)
       VALUES ($1, $2, 1, '{}', $3) RETURNING id`,
      [organisationId, form, publisherId],
    );
    await owner.query('UPDATE forms SET current_version_id = $1 WHERE id = $2', [version, form]);
    const submission = await one(
      `INSERT INTO submissions (organisation_id, conference_id, form_id, form_version_id, reference,
         language, answers, first_author_name, corresponding_email, corresponding_domain,
         author_count, consent_text, consent_version, consented_at, idempotency_key, payload_hash)
       VALUES ($1, $2, $3, $4, 'MX00-0001', 'en', '{}', 'Matrica Probna', 'a@a.example.test',
         'a.example.test', 1, 'I agree', 'x', now(), gen_random_uuid(), 'x') RETURNING id`,
      [organisationId, conference, form, version],
    );
    file = await one(
      `INSERT INTO files (organisation_id, kind, storage_key, original_name, detected_type,
         size_bytes, sha256, submission_id)
       VALUES ($1, 'submission_file', $3, 'a.pdf', 'pdf', 1, 'x', $2)
       RETURNING id`,
      [organisationId, submission, `org/${organisationId}/${randomUUID()}`],
    );
    await owner.query('COMMIT');
    return {
      '/api/v1/mail-servers/': server,
      '/api/v1/conferences/': conference,
      '/api/v1/mail-templates/': template,
      '/api/v1/mail-log/': entry,
      '/api/v1/forms/': form,
      '/api/v1/submissions/': submission,
    };
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

/** The permissions a reviewer holds (the seeded role_permissions; see permissions.ts). */
const REVIEWER_PERMISSIONS = new Set(['account.manage']);

describe('the authorisation matrix of the admin API', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    objects = await objectsOfA(owner, actors.a.organisation.id, actors.a.admin.id);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  /** The objects of organisation A that a path with `{id}` names, by the start of the path. */
  let objects: Readonly<Record<string, string>>;

  /** A path of the document with its parameters replaced by objects of organisation A. */
  function concrete(operation: Operation): string {
    const prefix = Object.keys(objects).find((start) => operation.path.startsWith(start));
    return (
      operation.path
        .replace('{id}', prefix === undefined ? actors.a.reviewer.id : (objects[prefix] ?? ''))
        .replace(/\{token\}/g, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
        .replace('{number}', '1')
        .replace('{kind}', 'abstract_submission')
        .replace('{fileId}', file) + (SAMPLE_QUERIES[operation.id] ?? '')
    );
  }

  /** The people behind the actors; a signed-in actor gets a fresh session for every call. */
  const PEOPLE = {
    adminA: () => actors.a.admin,
    reviewerA: () => actors.a.reviewer,
    adminB: () => actors.b.admin,
  } as const;

  /**
   * One call as an actor. A signed-in actor calls from a session of its own, so that an
   * operation that ends the session (sign out everywhere) touches no other row of the
   * matrix; an admin has given the password again, so that the answer of a sensitive
   * route comes from the object and not from that check.
   */
  async function call(actor: ActorName, operation: Operation) {
    let signedIn: SignedIn | null = null;
    if (actor === 'endedA') {
      signedIn = actors.sessions.endedA;
    } else if (actor !== 'anonymous') {
      signedIn = await signIn(e2e, PEOPLE[actor]());
      if (actor !== 'reviewerA') {
        await confirmPassword(e2e, signedIn);
      }
    }
    const body = SAMPLE_BODIES[operation.id]?.() ?? {};
    return as(e2e, signedIn, operation.method, concrete(operation)).send(body);
  }

  it('every operation that takes a body has a sample body here, and no other has one', () => {
    const withBody = OPERATIONS.filter((operation) => operation.hasBody).map(
      (operation) => operation.id,
    );
    expect(withBody.sort()).toEqual(Object.keys(SAMPLE_BODIES).sort());
  });

  it('every operation of the document declares who may call it', () => {
    expect(OPERATIONS.length).toBeGreaterThan(20);
    for (const operation of OPERATIONS) {
      const access = document.paths[operation.path]?.[operation.method]?.['x-confera-access'];
      expect({ operation, declared: access !== undefined }).toEqual({ operation, declared: true });
    }
  });

  const protectedOperations = OPERATIONS.filter((operation) => operation.permission !== null);
  const publicOperations = OPERATIONS.filter((operation) => operation.permission === null);

  it('there are routes of both kinds', () => {
    expect(protectedOperations.length).toBeGreaterThan(10);
    expect(publicOperations.length).toBeGreaterThan(5);
  });

  describe('anonymous', () => {
    it.each(protectedOperations)('$method $path: 401', async (operation) => {
      const response = await call('anonymous', operation);
      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        expect.objectContaining({ code: 'unauthenticated', status: 401 }),
      );
    });

    it.each(publicOperations)('$method $path: the door is open', async (operation) => {
      const seen = verdict(await call('anonymous', operation));
      expect(REFUSALS.has(seen.code) ? seen : null).toBeNull();
    });
  });

  describe('a session that was ended on the server', () => {
    it.each(protectedOperations)('$method $path: 401', async (operation) => {
      expect((await call('endedA', operation)).status).toBe(401);
    });
  });

  describe('a reviewer of the same organisation', () => {
    const outside = protectedOperations.filter(
      (operation) => !REVIEWER_PERMISSIONS.has(operation.permission ?? ''),
    );
    const inside = protectedOperations.filter((operation) =>
      REVIEWER_PERMISSIONS.has(operation.permission ?? ''),
    );

    it.each(outside)('$method $path: 403', async (operation) => {
      const response = await call('reviewerA', operation);
      expect(response.status).toBe(403);
      expect(response.body).toEqual(expect.objectContaining({ code: 'forbidden' }));
    });

    it.each(inside)('$method $path: the door is open', async (operation) => {
      const seen = verdict(await call('reviewerA', operation));
      expect(REFUSALS.has(seen.code) ? seen : null).toBeNull();
    });
  });

  describe('an admin of another organisation', () => {
    const withObject = protectedOperations.filter((operation) => operation.path.includes('{id}'));

    it('there are routes that name an object', () => {
      expect(withObject.length).toBeGreaterThan(5);
    });

    it.each(withObject)('$method $path of an object of A: 404', async (operation) => {
      const response = await call('adminB', operation);
      expect(response.status).toBe(404);
      expect(response.body).toEqual(expect.objectContaining({ code: 'not_found' }));
    });
  });

  describe('an admin of the organisation', () => {
    it.each(protectedOperations)('$method $path: the door is open', async (operation) => {
      const seen = verdict(await call('adminA', operation));
      expect(REFUSALS.has(seen.code) ? seen : null).toBeNull();
    });
  });

  describe('the password asked again', () => {
    const sensitive = protectedOperations.filter((operation) => operation.freshPassword);

    it('users, roles, the payment details and mail servers are sensitive changes', () => {
      expect(
        sensitive.map((operation) => `${operation.method.toUpperCase()} ${operation.path}`),
      ).toEqual(
        expect.arrayContaining([
          'POST /api/v1/users',
          'PUT /api/v1/users/{id}/role',
          'DELETE /api/v1/users/{id}',
          'PUT /api/v1/organisation/payment-details',
          'POST /api/v1/mail-servers',
          'PATCH /api/v1/mail-servers/{id}',
          'DELETE /api/v1/mail-servers/{id}',
        ]),
      );
    });

    /** A second session of the admin of A, which never gave the password again. */
    let fresh: SignedIn;

    beforeAll(async () => {
      fresh = await signIn(e2e, actors.a.admin);
    });

    it.each(sensitive)(
      '$method $path: 403 password_confirmation_required without it',
      async (operation) => {
        const response = await as(e2e, fresh, operation.method, concrete(operation)).send(
          SAMPLE_BODIES[operation.id]?.() ?? {},
        );
        expect(response.status).toBe(403);
        expect(response.body).toEqual(
          expect.objectContaining({ code: 'password_confirmation_required' }),
        );
      },
    );
  });
});
