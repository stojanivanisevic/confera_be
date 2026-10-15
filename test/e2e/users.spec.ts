import type { Client } from 'pg';
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
import { Factories, INVENTED_PASSWORD } from './support/factories';

/**
 * User administration (M2-BE-04; FR-USR-01, FR-USR-02, FR-USR-04; ST-19): the password
 * asked again, the notice to every admin, the last-admin rule, two admins at once, a
 * removed user's attribution, and another organisation's users.
 */
describe('users', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    admin = await signIn(e2e, actors.a.admin);
    await confirmPassword(e2e, admin);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  async function inA<T>(work: () => Promise<T>): Promise<T> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [actors.a.organisation.id]);
      return await work();
    } finally {
      await owner.query('COMMIT');
    }
  }

  /** The admins of A who got a security notice about `change` and `subjectUserId`. */
  async function noticed(change: string, subjectUserId: string): Promise<string[]> {
    const found = await inA(() =>
      rows<{ recipient_address: string }>(
        owner,
        `SELECT recipient_address FROM mail_outbox WHERE kind = 'security_notice'
           AND parameters->>'change' = $1 AND parameters->>'subjectUserId' = $2 ORDER BY 1`,
        [change, subjectUserId],
      ),
    );
    return found.map(({ recipient_address }) => recipient_address);
  }

  const invitation = () => ({
    email: `nova.osoba.${Date.now().toString(36)}@a.example.test`,
    displayName: 'Nova Osoba (izmišljeno)',
    role: 'reviewer',
  });

  describe('an invitation (FR-USR-02, ST-19)', () => {
    it('needs the password asked again', async () => {
      const fresh = await signIn(e2e, actors.a.admin);
      const response = await as(e2e, fresh, 'post', '/api/v1/users').send(invitation());
      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        expect.objectContaining({ code: 'password_confirmation_required' }),
      );
    });

    it('creates an invited user, queues the invitation, and tells every active admin', async () => {
      const body = invitation();
      const response = await as(e2e, admin, 'post', '/api/v1/users').send(body);
      expect(response.status).toBe(201);
      expect(response.body).toEqual(
        expect.objectContaining({
          email: body.email,
          displayName: body.displayName,
          role: 'reviewer',
          status: 'invited',
          version: 1,
        }),
      );
      const id = (response.body as { id: string }).id;
      const queued = await inA(() =>
        rows<{ kind: string; recipient_address: string; link_purpose: string }>(
          owner,
          "SELECT kind, recipient_address, link_purpose FROM mail_outbox WHERE recipient_user_id = $1 AND kind = 'invitation'",
          [id],
        ),
      );
      expect(queued).toEqual([
        { kind: 'invitation', recipient_address: body.email, link_purpose: 'invitation' },
      ]);
      // Both active admins of A: the admin and the one whose session was ended. Nobody of B.
      expect(await noticed('user_invited', id)).toEqual(
        [actors.a.admin.email, actors.a.ended.email].sort(),
      );
    });

    it('refuses an address that has an account, and an address that is not one', async () => {
      const taken = await as(e2e, admin, 'post', '/api/v1/users').send({
        ...invitation(),
        email: actors.b.admin.email,
      });
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual(expect.objectContaining({ code: 'email_taken' }));
      const malformed = await as(e2e, admin, 'post', '/api/v1/users').send({
        ...invitation(),
        email: 'a@b@c.example.test',
      });
      expect(malformed.status).toBe(400);
      const hostile = await as(e2e, admin, 'post', '/api/v1/users').send({
        ...invitation(),
        displayName: 'Ime‮emi',
      });
      expect(hostile.status).toBe(400);
      expect(hostile.body).toEqual(
        expect.objectContaining({ errors: [{ path: 'displayName', code: 'isPlainText' }] }),
      );
    });

    it('a double submit queues one invitation, and a resend a second with a new link', async () => {
      const body = invitation();
      const [first, second] = await Promise.all([
        as(e2e, admin, 'post', '/api/v1/users').send(body),
        as(e2e, admin, 'post', '/api/v1/users').send(body),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const id = ((first.status === 201 ? first : second).body as { id: string }).id;
      const resent = await as(e2e, admin, 'post', `/api/v1/users/${id}/invitation`).send({});
      expect(resent.status).toBe(202);
      const queued = await inA(() =>
        rows<{ unique_key: string }>(
          owner,
          "SELECT unique_key FROM mail_outbox WHERE recipient_user_id = $1 AND kind = 'invitation'",
          [id],
        ),
      );
      expect(queued).toHaveLength(2);
    });
  });

  describe('the list', () => {
    it('is paged, searchable without regard to case, and leaves removed users out', async () => {
      const page = await as(e2e, admin, 'get', '/api/v1/users?pageSize=2&page=1');
      expect(page.status).toBe(200);
      expect(page.body).toEqual(
        expect.objectContaining({ page: 1, pageSize: 2, items: expect.any(Array) }),
      );
      expect((page.body as { items: unknown[] }).items).toHaveLength(2);
      const search = await as(
        e2e,
        admin,
        'get',
        `/api/v1/users?search=${encodeURIComponent(actors.a.reviewer.displayName.toUpperCase().slice(0, 6))}`,
      );
      expect((search.body as { items: { id: string }[] }).items.map(({ id }) => id)).toContain(
        actors.a.reviewer.id,
      );
      const pattern = await as(e2e, admin, 'get', '/api/v1/users?search=%25');
      expect((pattern.body as { total: number }).total).toBe(0);
      const tooBig = await as(e2e, admin, 'get', '/api/v1/users?pageSize=101');
      expect(tooBig.status).toBe(400);
    });

    it('shows no user of another organisation (FR-ORG-01)', async () => {
      const list = await as(e2e, actors.sessions.adminB, 'get', '/api/v1/users?pageSize=100');
      const emails = (list.body as { items: { email: string }[] }).items.map(({ email }) => email);
      expect(emails).toContain(actors.b.admin.email);
      expect(emails).not.toContain(actors.a.admin.email);
      expect(
        (await as(e2e, actors.sessions.adminB, 'get', `/api/v1/users/${actors.a.reviewer.id}`))
          .status,
      ).toBe(404);
    });
  });

  describe('changes (FR-USR-04, ST-19)', () => {
    it('a change of role ends the user’s sessions and tells the admins; the version moves on', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const theirs = await signIn(e2e, person);
      const response = await as(e2e, admin, 'put', `/api/v1/users/${person.id}/role`).send({
        role: 'admin',
        version: 1,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({ role: 'admin', version: 2 }));
      expect((await as(e2e, theirs, 'get', '/api/v1/session')).status).toBe(401);
      expect(await noticed('user_role_changed', person.id)).toEqual(
        expect.arrayContaining([actors.a.admin.email]),
      );
      const stale = await as(e2e, admin, 'patch', `/api/v1/users/${person.id}`).send({
        displayName: 'Drugo Ime',
        version: 1,
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual(expect.objectContaining({ code: 'version_conflict' }));
      const [entry] = await inA(() =>
        rows<{ fields: string[]; changes: object }>(
          owner,
          "SELECT fields, changes FROM audit_entries WHERE action = 'user.role_changed' AND subject_id = $1",
          [person.id],
        ),
      );
      expect(entry).toEqual({ fields: ['role'], changes: {} });
    });

    it('two admins editing the same user: the second change on the old version is refused', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const other = await signIn(e2e, actors.a.ended);
      await confirmPassword(e2e, other);
      const [one, two] = await Promise.all([
        as(e2e, admin, 'patch', `/api/v1/users/${person.id}`).send({
          displayName: 'Prvo Ime',
          version: 1,
        }),
        as(e2e, other, 'patch', `/api/v1/users/${person.id}`).send({
          displayName: 'Drugo Ime',
          version: 1,
        }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
    });

    it('deactivation and reactivation; a deactivated person cannot sign in', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const off = await as(e2e, admin, 'post', `/api/v1/users/${person.id}/deactivation`).send({
        version: 1,
      });
      expect(off.status).toBe(200);
      expect(off.body).toEqual(expect.objectContaining({ status: 'deactivated', version: 2 }));
      await expect(signIn(e2e, person)).rejects.toThrow(/401/);
      const on = await as(e2e, admin, 'post', `/api/v1/users/${person.id}/reactivation`).send({
        version: 2,
      });
      expect(on.body).toEqual(expect.objectContaining({ status: 'active', version: 3 }));
      expect((await signIn(e2e, person)).session.user.id).toBe(person.id);
    });

    it('a removed user stays attributed, is left out of the list, and frees the address', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const theirs = await signIn(e2e, person);
      await as(e2e, theirs, 'delete', '/api/v1/session').expect(204);
      const removed = await as(e2e, admin, 'delete', `/api/v1/users/${person.id}?version=1`);
      expect(removed.status).toBe(204);
      const list = await as(e2e, admin, 'get', '/api/v1/users?pageSize=100');
      expect((list.body as { items: { id: string }[] }).items.map(({ id }) => id)).not.toContain(
        person.id,
      );
      const got = await as(e2e, admin, 'get', `/api/v1/users/${person.id}`);
      expect(got.body).toEqual(expect.objectContaining({ status: 'removed' }));
      const [signedOut] = await inA(() =>
        rows<{ actor_user_id: string }>(
          owner,
          "SELECT actor_user_id FROM audit_entries WHERE action = 'session.signed_out' AND actor_user_id = $1",
          [person.id],
        ),
      );
      expect(signedOut?.actor_user_id).toBe(person.id);
      const again = await as(e2e, admin, 'post', '/api/v1/users').send({
        ...invitation(),
        email: person.email,
      });
      expect(again.status).toBe(201);
      expect(await noticed('user_removed', person.id)).toEqual(
        expect.arrayContaining([actors.a.admin.email]),
      );
    });

    it('an admin ends another user’s sessions', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const theirs = await signIn(e2e, person);
      expect((await as(e2e, admin, 'delete', `/api/v1/users/${person.id}/sessions`)).status).toBe(
        204,
      );
      expect((await as(e2e, theirs, 'get', '/api/v1/session')).status).toBe(401);
    });

    it('a user of another organisation is not found for any change', async () => {
      const b = await signIn(e2e, actors.b.admin);
      await confirmPassword(e2e, b);
      const target = actors.a.reviewer.id;
      for (const [method, path, body] of [
        ['patch', `/api/v1/users/${target}`, { displayName: 'X Y', version: 1 }],
        ['put', `/api/v1/users/${target}/role`, { role: 'admin', version: 1 }],
        ['post', `/api/v1/users/${target}/deactivation`, { version: 1 }],
        ['delete', `/api/v1/users/${target}?version=1`, {}],
        ['delete', `/api/v1/users/${target}/sessions`, {}],
      ] as const) {
        expect((await as(e2e, b, method, path).send(body)).status).toBe(404);
      }
      const untouched = await as(e2e, admin, 'get', `/api/v1/users/${target}`);
      expect(untouched.body).toEqual(
        expect.objectContaining({
          displayName: actors.a.reviewer.displayName,
          status: 'active',
          version: 1,
        }),
      );
    });
  });

  describe('the last active admin (FR-USR-04)', () => {
    it('cannot be demoted, deactivated or removed, also when two admins try at once', async () => {
      // Organisation B has one admin.
      const b = await signIn(e2e, actors.b.admin);
      await confirmPassword(e2e, b);
      const me = actors.b.admin.id;
      const demote = await as(e2e, b, 'put', `/api/v1/users/${me}/role`).send({
        role: 'reviewer',
        version: 1,
      });
      expect(demote.status).toBe(409);
      expect(demote.body).toEqual(expect.objectContaining({ code: 'last_admin' }));
      expect(
        (await as(e2e, b, 'post', `/api/v1/users/${me}/deactivation`).send({ version: 1 })).status,
      ).toBe(409);
      expect((await as(e2e, b, 'delete', `/api/v1/users/${me}?version=1`)).status).toBe(409);
      // A second admin, then both demote the other at the same moment: one of them stays.
      const second = await new Factories(owner).user(actors.b.organisation, { role: 'admin' });
      const two = await signIn(e2e, second);
      await confirmPassword(e2e, two);
      const [x, y] = await Promise.all([
        as(e2e, b, 'put', `/api/v1/users/${second.id}/role`).send({ role: 'reviewer', version: 1 }),
        as(e2e, two, 'put', `/api/v1/users/${me}/role`).send({ role: 'reviewer', version: 1 }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const admins = await as(
        e2e,
        x.status === 200 ? b : two,
        'get',
        '/api/v1/users?role=admin&status=active',
      );
      expect((admins.body as { total: number }).total).toBe(1);
    });
  });

  it('a reviewer may read nothing of this and change nothing', async () => {
    const reviewer = await signIn(e2e, actors.a.reviewer);
    expect((await as(e2e, reviewer, 'get', '/api/v1/users')).status).toBe(403);
    expect((await as(e2e, reviewer, 'post', '/api/v1/users').send(invitation())).status).toBe(403);
    expect(INVENTED_PASSWORD.startsWith('invented-')).toBe(true);
  });
});
