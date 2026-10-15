import type { Client } from 'pg';
import { ROLE_PERMISSIONS } from '../../src/modules/access/permissions';
import {
  connect,
  connectAsSuperuser,
  errorCode,
  inOrganisation,
  rows,
  seedTwoOrganisations,
  SQLSTATE,
  testDatabase,
  type TwoOrganisations,
} from './support/database';

/**
 * What the database itself refuses (M2-BE-01, M2-BE-06; ADR-05, ADR-06; ST-24):
 *
 * - the audit log is insert-only for both run-time roles: UPDATE, DELETE and TRUNCATE fail;
 * - the roles and their permissions are what the code constants say, and the run-time
 *   roles cannot change them;
 * - the security events of the instance are out of reach of any statement that works
 *   inside an organisation.
 */
describe('the audit log and the reference and instance tables', () => {
  jest.setTimeout(120_000);

  let superuser: Client;
  let app: Client;
  let system: Client;
  let organisations: TwoOrganisations;

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
    organisations = await seedTwoOrganisations(superuser);
    app = await connect(testDatabase.applicationUrl);
    system = await connect(testDatabase.systemUrl);
    await superuser.query('TRUNCATE audit_entries, security_events');
  });

  afterAll(async () => {
    await app.end();
    await system.end();
    await superuser.end();
  });

  describe('the audit log can only grow (ST-24)', () => {
    let entryId: string;

    beforeAll(async () => {
      const admin = organisations.a.users[0]!;
      entryId = await inOrganisation(app, organisations.a.id, async () => {
        const [inserted] = await rows<{ id: string }>(
          app,
          `INSERT INTO audit_entries (organisation_id, actor_user_id, action, subject_type, subject_id, fields)
           VALUES ($1, $2, 'user.updated', 'user', $2, ARRAY['displayName']) RETURNING id`,
          [organisations.a.id, admin.id],
        );
        return inserted!.id;
      });
    });

    it.each([
      [
        'UPDATE',
        (id: string) => [`UPDATE audit_entries SET action = 'x' WHERE id = $1`, [id]] as const,
      ],
      ['DELETE', (id: string) => [`DELETE FROM audit_entries WHERE id = $1`, [id]] as const],
      ['TRUNCATE', () => ['TRUNCATE audit_entries', []] as const],
    ])('%s fails as the application role', async (_name, statement) => {
      const [sql, values] = statement(entryId);
      const code = await inOrganisation(app, organisations.a.id, () =>
        errorCode(() => app.query(sql, [...values])),
      );
      expect(code).toBe(SQLSTATE.insufficientPrivilege);
    });

    it.each([
      ['SELECT', 'SELECT * FROM audit_entries'],
      [
        'INSERT',
        "INSERT INTO audit_entries (organisation_id, action, subject_type) SELECT id, 'x', 'x' FROM organisations",
      ],
      ['UPDATE', "UPDATE audit_entries SET action = 'x'"],
      ['DELETE', 'DELETE FROM audit_entries'],
      ['TRUNCATE', 'TRUNCATE audit_entries'],
    ])('%s fails as the system role', async (_name, sql) => {
      expect(await errorCode(() => system.query(sql))).toBe(SQLSTATE.insufficientPrivilege);
    });

    it('the entry is still there, unchanged', async () => {
      const found = await inOrganisation(app, organisations.a.id, () =>
        rows<{ action: string }>(app, 'SELECT action FROM audit_entries WHERE id = $1', [entryId]),
      );
      expect(found).toEqual([{ action: 'user.updated' }]);
    });

    it('an entry of A is invisible from B, and B cannot write one for A', async () => {
      const fromB = await inOrganisation(app, organisations.b.id, () =>
        rows(app, 'SELECT id FROM audit_entries WHERE id = $1', [entryId]),
      );
      expect(fromB).toEqual([]);
      const code = await inOrganisation(app, organisations.b.id, () =>
        errorCode(() =>
          app.query(
            "INSERT INTO audit_entries (organisation_id, action, subject_type) VALUES ($1, 'x', 'x')",
            [organisations.a.id],
          ),
        ),
      );
      expect(code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  describe('the roles and their permissions (reference tables)', () => {
    it('are what the code says (src/modules/access/permissions.ts)', async () => {
      const seeded = await rows<{ role: string; permission: string }>(
        superuser,
        'SELECT role, permission FROM role_permissions ORDER BY 1, 2',
      );
      const expected = Object.entries(ROLE_PERMISSIONS)
        .flatMap(([role, permissions]) => permissions.map((permission) => ({ role, permission })))
        .sort((x, y) => `${x.role} ${x.permission}`.localeCompare(`${y.role} ${y.permission}`));
      expect(seeded).toEqual(expected);
      const roles = await rows<{ name: string }>(superuser, 'SELECT name FROM roles ORDER BY 1');
      expect(roles.map(({ name }) => name)).toEqual(Object.keys(ROLE_PERMISSIONS).sort());
    });

    it('are readable by the application role with or without an organisation, and not writable by any run-time role', async () => {
      expect((await rows(app, 'SELECT * FROM roles')).length).toBe(2);
      expect(
        (
          await inOrganisation(app, organisations.a.id, () =>
            rows(app, 'SELECT * FROM role_permissions'),
          )
        ).length,
      ).toBeGreaterThan(2);
      for (const client of [app, system]) {
        for (const sql of [
          "INSERT INTO roles (name, description) VALUES ('owner', 'x')",
          "INSERT INTO role_permissions (role, permission) VALUES ('reviewer', 'users.manage')",
          "DELETE FROM role_permissions WHERE role = 'reviewer'",
          "UPDATE roles SET description = 'x'",
        ]) {
          expect(await errorCode(() => client.query(sql))).toBe(SQLSTATE.insufficientPrivilege);
        }
      }
      // A role that no row of "roles" names cannot be given to a user.
      const code = await inOrganisation(app, organisations.a.id, () =>
        errorCode(() =>
          app.query(
            "INSERT INTO user_roles (organisation_id, user_id, role) VALUES ($1, $2, 'owner')",
            [organisations.a.id, organisations.a.users[0]!.id],
          ),
        ),
      );
      expect(code).toBe(SQLSTATE.foreignKeyViolation);
    });
  });

  describe('the security events of the instance', () => {
    it('exist only for a statement that works outside any organisation', async () => {
      await app.query(
        "INSERT INTO security_events (kind, client_address) VALUES ('sign_in_failed', '203.0.113.7')",
      );
      expect((await rows(app, 'SELECT id FROM security_events')).length).toBeGreaterThanOrEqual(1);
      const seen = await inOrganisation(app, organisations.a.id, () =>
        rows(app, 'SELECT id FROM security_events'),
      );
      expect(seen).toEqual([]);
      const code = await inOrganisation(app, organisations.a.id, () =>
        errorCode(() =>
          app.query(
            "INSERT INTO security_events (kind, client_address) VALUES ('sign_in_failed', '203.0.113.8')",
          ),
        ),
      );
      expect(code).toBe(SQLSTATE.insufficientPrivilege);
      expect(await errorCode(() => system.query('SELECT * FROM security_events'))).toBe(
        SQLSTATE.insufficientPrivilege,
      );
    });
  });
});
