import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { repoRoot } from '../support/run-node';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner, rows } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * The organisation profile and the two-organisation fixture (M2-BE-05; FR-ORG-01 to 03;
 * ST-19): no request of one organisation reads or changes the other's data.
 */
describe('the organisation', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let adminA: SignedIn;
  let adminB: SignedIn;

  const PAYMENT = {
    rsdAccount: '160-0000000000123-95',
    eurIban: 'RS35 2600 0560 1001 6113 79',
    eurSwift: 'BACXRSBG',
    eurBankName: 'Banka Probna (izmišljeno)',
    paypalPayee: 'blagajna@a.example.test',
  };

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    adminA = await signIn(e2e, actors.a.admin);
    adminB = await signIn(e2e, actors.b.admin);
    await confirmPassword(e2e, adminA);
    await confirmPassword(e2e, adminB);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  async function inOrganisation<T>(organisationId: string, work: () => Promise<T>): Promise<T> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
      return await work();
    } finally {
      await owner.query('COMMIT');
    }
  }

  it('an admin reads the own organisation and nothing of the other (FR-ORG-01)', async () => {
    const a = await as(e2e, adminA, 'get', '/api/v1/organisation');
    const b = await as(e2e, adminB, 'get', '/api/v1/organisation');
    expect(a.body).toEqual(
      expect.objectContaining({
        id: actors.a.organisation.id,
        name: actors.a.organisation.name,
        version: 1,
      }),
    );
    expect(b.body).toEqual(expect.objectContaining({ id: actors.b.organisation.id }));
    expect(JSON.stringify(b.body)).not.toContain(actors.a.organisation.id);
  });

  it('the issuer data are entered by an admin, with the checks of each identifier (FR-ORG-03)', async () => {
    const bad = await as(e2e, adminA, 'patch', '/api/v1/organisation').send({
      taxNumber: '123456789',
      registrationNumber: '12',
      version: 1,
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([
          { path: 'taxNumber', code: 'isTaxNumber' },
          { path: 'registrationNumber', code: 'isRegistrationNumber' },
        ]),
      }),
    );
    const ok = await as(e2e, adminA, 'patch', '/api/v1/organisation').send({
      legalName: 'Udruženje za probe A (izmišljeno)',
      address: 'Probna ulica 1\n11000 Beograd',
      taxNumber: '100001100',
      registrationNumber: '12345678',
      contactEmail: 'office@a.example.test',
      vatNoteSr: 'Nije u sistemu PDV-a.',
      vatNoteEn: 'Not in the VAT system.',
      version: 1,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual(
      expect.objectContaining({
        taxNumber: '100001100',
        version: 2,
        contactEmail: 'office@a.example.test',
      }),
    );
    const stale = await as(e2e, adminA, 'patch', '/api/v1/organisation').send({
      legalName: 'Drugo',
      version: 1,
    });
    expect(stale.status).toBe(409);
    // The audit log keeps the old and new value of the issuer data (settings of a legal entity).
    const [entry] = await inOrganisation(actors.a.organisation.id, () =>
      rows<{
        fields: string[];
        changes: Record<string, { old: string | null; new: string | null }>;
      }>(
        owner,
        "SELECT fields, changes FROM audit_entries WHERE action = 'organisation.updated' ORDER BY occurred_at LIMIT 1",
      ),
    );
    expect(entry?.fields).toEqual(
      expect.arrayContaining(['taxNumber', 'legalName', 'contactEmail']),
    );
    expect(entry?.changes.taxNumber).toEqual({ old: null, new: '100001100' });
    // Not the contact address: it may be a person's.
    expect(entry?.changes).not.toHaveProperty('contactEmail');
  });

  describe('the payment details (ST-19)', () => {
    it('need the password asked again', async () => {
      const fresh = await signIn(e2e, actors.a.admin);
      const response = await as(e2e, fresh, 'put', '/api/v1/organisation/payment-details').send({
        ...PAYMENT,
        version: 2,
      });
      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        expect.objectContaining({ code: 'password_confirmation_required' }),
      );
    });

    it('check the account numbers', async () => {
      const response = await as(e2e, adminA, 'put', '/api/v1/organisation/payment-details').send({
        ...PAYMENT,
        rsdAccount: '160-0000000000123-96',
        eurIban: 'RS35 2600 0560 1001 6113 78',
        eurSwift: 'bad',
        version: 2,
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        expect.objectContaining({
          errors: expect.arrayContaining([
            { path: 'rsdAccount', code: 'isSerbianAccount' },
            { path: 'eurIban', code: 'isIban' },
            { path: 'eurSwift', code: 'isBic' },
          ]),
        }),
      );
    });

    it('are changed with who and when, the audit log names the changed fields, and every active admin is told', async () => {
      const response = await as(e2e, adminA, 'put', '/api/v1/organisation/payment-details').send({
        ...PAYMENT,
        version: 2,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          rsdAccount: PAYMENT.rsdAccount,
          eurIban: 'RS35260005601001611379',
          paypalPayee: PAYMENT.paypalPayee,
          paymentDetailsChangedAt: expect.any(String),
          paymentDetailsChangedBy: {
            id: actors.a.admin.id,
            displayName: actors.a.admin.displayName,
          },
          version: 3,
        }),
      );
      const [entry] = await inOrganisation(actors.a.organisation.id, () =>
        rows<{
          actor_user_id: string;
          fields: string[];
          changes: Record<string, { old: string | null; new: string | null }>;
        }>(
          owner,
          "SELECT actor_user_id, fields, changes FROM audit_entries WHERE action = 'organisation.payment_details_changed'",
        ),
      );
      expect(entry?.actor_user_id).toBe(actors.a.admin.id);
      // The log says that the account numbers changed, never to what (D9).
      expect(entry?.fields).toEqual(expect.arrayContaining(['rsdAccount', 'eurIban']));
      expect(entry?.changes).not.toHaveProperty('rsdAccount');
      expect(entry?.changes).not.toHaveProperty('eurIban');
      expect(JSON.stringify(entry?.changes)).not.toContain(PAYMENT.rsdAccount);
      expect(entry?.fields).toContain('paypalPayee');
      expect(entry?.changes).not.toHaveProperty('paypalPayee');
      const notices = await inOrganisation(actors.a.organisation.id, () =>
        rows<{ recipient_address: string }>(
          owner,
          "SELECT recipient_address FROM mail_outbox WHERE kind = 'security_notice' AND parameters->>'change' = 'organisation_payment_details_changed' ORDER BY 1",
        ),
      );
      expect(notices.map(({ recipient_address }) => recipient_address)).toEqual(
        [actors.a.admin.email, actors.a.ended.email].sort(),
      );
      // The audit log as an admin reads it: the account numbers neither in this entry nor in
      // one written while they were still on the list (0.2.0), D9.
      await inOrganisation(actors.a.organisation.id, () =>
        rows(
          owner,
          `INSERT INTO audit_entries (organisation_id, action, subject_type, fields, changes)
           VALUES ($1, 'organisation.payment_details_changed', 'organisation', '{eurIban}',
                   '{"eurIban":{"old":null,"new":"RS35260005601001611379"}}')`,
          [actors.a.organisation.id],
        ),
      );
      const log = await as(
        e2e,
        adminA,
        'get',
        '/api/v1/audit?action=organisation.payment_details_changed',
      );
      expect(log.status).toBe(200);
      expect((log.body as { total: number }).total).toBe(2);
      expect(JSON.stringify(log.body)).not.toContain('RS35260005601001611379');
      expect(JSON.stringify(log.body)).not.toContain(PAYMENT.rsdAccount);
      // Nothing of it reached B.
      const b = await as(e2e, adminB, 'get', '/api/v1/organisation');
      expect(b.body).toEqual(
        expect.objectContaining({ rsdAccount: null, eurIban: null, version: 1 }),
      );
    });
  });

  describe('no request of one organisation reads or changes the other’s data (FR-ORG-01, M2-BE-05)', () => {
    interface OpenApiDocument {
      readonly paths: Record<string, Record<string, unknown>>;
    }
    const document = JSON.parse(
      readFileSync(join(repoRoot, 'openapi', 'openapi.json'), 'utf8'),
    ) as OpenApiDocument;
    const reads = Object.entries(document.paths)
      .filter(([, item]) => 'get' in item)
      .map(([path]) => path)
      .filter((path) => !path.includes('{token}'));
    /** The reading routes that page: they are asked for their largest page. */
    const paged = new Set(
      Object.entries(document.paths)
        .filter(([, item]) =>
          JSON.stringify(
            (item.get as { parameters?: unknown } | undefined)?.parameters ?? [],
          ).includes('"name":"pageSize"'),
        )
        .map(([path]) => path),
    );

    it('every reading route, asked by the admin of B, shows nothing of A', async () => {
      expect(reads.length).toBeGreaterThanOrEqual(5);
      const marks = [
        actors.a.organisation.id,
        actors.a.organisation.name,
        actors.a.admin.id,
        actors.a.admin.email,
        actors.a.reviewer.email,
        PAYMENT.rsdAccount,
        'RS35260005601001611379',
        '100001100',
      ];
      for (const path of reads) {
        const concrete = path.replace('{id}', actors.a.reviewer.id);
        const response = await as(
          e2e,
          adminB,
          'get',
          paged.has(path) ? `${concrete}?pageSize=100` : concrete,
        );
        expect([200, 404]).toContain(response.status);
        for (const mark of marks) {
          expect({ path, mark, found: response.text.includes(mark) }).toEqual({
            path,
            mark,
            found: false,
          });
        }
      }
    });

    it('the audit log of B holds nothing of A, and A’s changes are not in it', async () => {
      const audit = await as(e2e, adminB, 'get', '/api/v1/audit?pageSize=100');
      expect(audit.status).toBe(200);
      const actions = (audit.body as { items: { action: string }[] }).items.map(
        ({ action }) => action,
      );
      expect(actions).not.toContain('organisation.payment_details_changed');
    });

    it('a change tried by B on A changes nothing of A', async () => {
      const before = await as(e2e, adminA, 'get', '/api/v1/organisation');
      expect(
        (
          await as(e2e, adminB, 'patch', `/api/v1/users/${actors.a.admin.id}`).send({
            displayName: 'Uljez',
            version: 1,
          })
        ).status,
      ).toBe(404);
      const after = await as(e2e, adminA, 'get', '/api/v1/organisation');
      expect(after.body).toEqual(before.body);
      const user = await as(e2e, adminA, 'get', `/api/v1/users/${actors.a.admin.id}`);
      expect(user.body).toEqual(
        expect.objectContaining({ displayName: actors.a.admin.displayName }),
      );
    });
  });
});
