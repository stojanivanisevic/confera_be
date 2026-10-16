import type { Client, QueryResultRow } from 'pg';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import { ADMIN_HOST, type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD } from './support/factories';
import { linkPath, mintLink } from './support/links';

/**
 * Edge cases of users and of the own account (ADR-03, FR-USR-02 to 06) found by the
 * edge-case hunter. Each test fails today, for the reason in its comment.
 */
describe('users and the own account', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;

  async function inA<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [actors.a.organisation.id]);
      const result = await owner.query<T>(sql, values);
      await owner.query('COMMIT');
      return result.rows;
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

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

  const anonymousSignIn = (email: string, password: string) =>
    e2e
      .http()
      .post('/api/v1/session')
      .set('Host', ADMIN_HOST)
      .set('Origin', e2e.config.origins.admin)
      .send({ email, password });

  // E2-11. FR-USR-06 counts a password "in Unicode code points of the password in NFC": the
  // rules treat the two spellings of "š" (U+0161, and "s" with U+030C) as one letter. The
  // hash is made over the bytes as typed, so a person who sets "šifra" on a keyboard that
  // composes and signs in on one that decomposes (or pastes from a password manager) is
  // told the password is wrong. NIST SP 800-63B: normalise before hashing.
  it('a password with Serbian letters opens the account whichever way the letters are composed', async () => {
    const invited = await new Factories(owner).user(actors.a.organisation, {
      role: 'reviewer',
      status: 'invited',
    });
    const password = 'Šećerana-žuta-đurđevak-77'.normalize('NFC');
    const token = await mintLink(e2e, {
      organisationId: actors.a.organisation.id,
      purpose: 'invitation',
      userId: invited.id,
      recipient: invited.email,
    });
    const accepted = await e2e
      .http()
      .post(linkPath('invitation', token))
      .set('Host', ADMIN_HOST)
      .set('Origin', e2e.config.origins.admin)
      .send({ password, passwordRepeat: password });
    expect(accepted.status).toBe(204);

    expect((await anonymousSignIn(invited.email, password)).status).toBe(200);
    expect((await anonymousSignIn(invited.email, password.normalize('NFD'))).status).toBe(200);
  });

  // E2-12. FR-USR-04: "A removed user stays, so that past actions stay attributed: state
  // `removed`, no password". The routes load the row without looking at its state: a removed
  // user can be given the admin role, be renamed (the name in every old audit entry changes
  // with it) and have "sessions ended", each time with an audit entry and a notice to every
  // admin about a person who is no longer there.
  describe('a removed user is only a name on past actions', () => {
    async function removedUser() {
      const user = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const shown = (await as(e2e, admin, 'get', `/api/v1/users/${user.id}`)).body as {
        version: number;
      };
      await confirmPassword(e2e, admin);
      const removed = await as(
        e2e,
        admin,
        'delete',
        `/api/v1/users/${user.id}?version=${String(shown.version)}`,
      );
      expect(removed.status).toBe(204);
      const after = (await as(e2e, admin, 'get', `/api/v1/users/${user.id}?`)).body as {
        version: number;
      };
      return { user, version: after.version };
    }

    it('cannot be given a role', async () => {
      const { user, version } = await removedUser();
      await confirmPassword(e2e, admin);
      const response = await as(e2e, admin, 'put', `/api/v1/users/${user.id}/role`).send({
        role: 'admin',
        version,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const [row] = await inA<{ role: string }>('SELECT role FROM user_roles WHERE user_id = $1', [
        user.id,
      ]);
      expect(row?.role).toBe('reviewer');
    });

    it('cannot be renamed', async () => {
      const { user, version } = await removedUser();
      await confirmPassword(e2e, admin);
      const response = await as(e2e, admin, 'patch', `/api/v1/users/${user.id}`).send({
        displayName: 'Preimenovana osoba',
        version,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  // E2-13. ADR-03: "the owner is told by email, and that notice is itself limited so the
  // brake cannot flood a mailbox"; ADR-04 gives a reset a cool-down and a daily cap for the
  // same reason. An email change has neither: one signed-in person (a reviewer will do) sends
  // as many messages as they like, with the association's name, to any address they type.
  it('an email change can be asked for only a few times a day, whoever the address is', async () => {
    const user = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
    const session = await signIn(e2e, user);
    for (let index = 0; index < 20; index += 1) {
      await as(e2e, session, 'post', '/api/v1/account/email').send({
        password: INVENTED_PASSWORD,
        newEmail: `treca.strana.${String(index)}@a.example.test`,
      });
    }
    const [count] = await inA<{ n: string }>(
      `SELECT count(*)::text AS n FROM mail_outbox
         WHERE kind = 'email_change_confirmation' AND recipient_user_id = $1`,
      [user.id],
    );
    expect(Number(count?.n)).toBeLessThanOrEqual(5);
  });
});
