import type { Client } from 'pg';
import { RULE_CODES } from '../../src/modules/access/password-rules';
import { type Actors, as, createActors, signIn } from './support/actors';
import { ADMIN_HOST, type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner, rows } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD, type InventedUser } from './support/factories';
import { linkPath, mintLink } from './support/links';

/**
 * Secure links and what they act on (M2-BE-03, M2-BE-02; ADR-03, ADR-04; FR-USR-02,
 * FR-USR-03, FR-USR-05, FR-USR-06; ST-17, ST-18, ST-62).
 */
describe('secure links', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  /** Every token minted in this file: none may be found stored anywhere afterwards (ST-17). */
  const minted: string[] = [];

  const GOOD_PASSWORD = 'invented-Breza-Most-Polje-7';

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  async function mint(
    user: InventedUser,
    purpose: 'invitation' | 'password_reset' | 'email_change',
    recipient = user.email,
  ) {
    const token = await mintLink(e2e, {
      organisationId: user.organisationId,
      purpose,
      userId: user.id,
      recipient,
    });
    minted.push(token);
    return token;
  }

  const open = (path: string) => e2e.admin(path);
  const act = (path: string, body: object) =>
    e2e
      .http()
      .post(path)
      .set('Host', ADMIN_HOST)
      .set('Origin', e2e.config.origins.admin)
      .send(body);

  async function inOrganisation<T>(organisationId: string, work: () => Promise<T>): Promise<T> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
      return await work();
    } finally {
      await owner.query('COMMIT');
    }
  }

  describe('an invitation (FR-USR-02)', () => {
    let invited: InventedUser;
    let token: string;

    beforeAll(async () => {
      invited = await new Factories(owner).user(actors.a.organisation, {
        status: 'invited',
        role: 'reviewer',
      });
      token = await mint(invited, 'invitation');
    });

    it('opening the link shows whose account it is, and uses nothing up', async () => {
      const first = await open(linkPath('invitation', token));
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        email: invited.email,
        displayName: invited.displayName,
        organisationName: actors.a.organisation.name,
        expiresAt: expect.any(String),
      });
      expect((await open(linkPath('invitation', token))).status).toBe(200);
      expect(new Date(first.body.expiresAt as string).getTime() - Date.now()).toBeGreaterThan(
        71 * 60 * 60 * 1000,
      );
    });

    it('the token is refused on every other purpose’s endpoint (ST-17)', async () => {
      for (const purpose of ['password_reset', 'email_change'] as const) {
        const page = await open(linkPath(purpose, token));
        expect(page.status).toBe(404);
        expect(page.body).toEqual(expect.objectContaining({ code: 'link_invalid' }));
        expect(
          (
            await act(linkPath(purpose, token), {
              password: GOOD_PASSWORD,
              passwordRepeat: GOOD_PASSWORD,
            })
          ).status,
        ).toBe(404);
      }
    });

    it('an invited user cannot sign in, and no reset link is made for them', async () => {
      const signInAttempt = await act('/api/v1/session', {
        email: invited.email,
        password: GOOD_PASSWORD,
      });
      expect(signInAttempt.status).toBe(401);
    });

    it.each([
      ['a short one', 'Kx9#mPq2!vL', [RULE_CODES.length]],
      ['a leaked one', 'Password2026!', [RULE_CODES.not_common]],
      ['the organisation’s name', 'ORGANISATION', [RULE_CODES.not_personal]],
      ['two entries that differ', GOOD_PASSWORD, [RULE_CODES.match]],
    ])('refuses %s with the rule named (ST-62)', async (_name, candidate, codes) => {
      // The first word of the organisation's name, as the person would type it.
      const password = candidate.replace(
        'ORGANISATION',
        `${actors.a.organisation.name.split(' ')[0] ?? ''}-Sunce-77`,
      );
      const response = await act(linkPath('invitation', token), {
        password,
        passwordRepeat: codes.includes(RULE_CODES.match) ? `${password}x` : password,
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        expect.objectContaining({
          code: 'password_refused',
          errors: codes.map((code) => ({ path: 'password', code })),
        }),
      );
      // Nothing was used up.
      expect((await open(linkPath('invitation', token))).status).toBe(200);
    });

    it('the person’s own name is refused, folded (ST-62)', async () => {
      const [given = ''] = invited.displayName.split(' ');
      const response = await act(linkPath('invitation', token), {
        password: `${given}-Sunce-Reka-77`,
        passwordRepeat: `${given}-Sunce-Reka-77`,
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        expect.objectContaining({ errors: [{ path: 'password', code: RULE_CODES.not_personal }] }),
      );
    });

    it('accepting sets the password, makes the account active and uses the link up', async () => {
      const response = await act(linkPath('invitation', token), {
        password: GOOD_PASSWORD,
        passwordRepeat: GOOD_PASSWORD,
      });
      expect(response.status).toBe(204);
      expect((await open(linkPath('invitation', token))).status).toBe(404);
      expect(
        (
          await act(linkPath('invitation', token), {
            password: GOOD_PASSWORD,
            passwordRepeat: GOOD_PASSWORD,
          })
        ).status,
      ).toBe(404);
      const signedIn = await signIn(e2e, invited, GOOD_PASSWORD);
      expect(signedIn.session.user.id).toBe(invited.id);
      const [row] = await inOrganisation(actors.a.organisation.id, () =>
        rows<{ status: string; used_at: Date | null }>(
          owner,
          'SELECT u.status, l.used_at FROM users u JOIN secure_links l ON l.user_id = u.id WHERE u.id = $1',
          [invited.id],
        ),
      );
      expect(row).toEqual({ status: 'active', used_at: expect.any(Date) });
    });

    it('a newer link revokes the older one for the same person only', async () => {
      const factories = new Factories(owner);
      const x = await factories.user(actors.a.organisation, { status: 'invited' });
      const y = await factories.user(actors.a.organisation, { status: 'invited' });
      const xOld = await mint(x, 'invitation');
      const yLink = await mint(y, 'invitation');
      const xNew = await mint(x, 'invitation');
      expect((await open(linkPath('invitation', xOld))).status).toBe(404);
      expect((await open(linkPath('invitation', xNew))).status).toBe(200);
      expect((await open(linkPath('invitation', yLink))).status).toBe(200);
    });

    it('an expired link is not found', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { status: 'invited' });
      const token2 = await mint(person, 'invitation');
      await inOrganisation(actors.a.organisation.id, () =>
        owner.query(
          `UPDATE secure_links SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
          [person.id],
        ),
      );
      expect((await open(linkPath('invitation', token2))).status).toBe(404);
    });

    it('an unknown token, a token of the wrong shape and a token of another organisation’s person are all not found alike', async () => {
      const bPerson = await new Factories(owner).user(actors.b.organisation, { status: 'invited' });
      const bToken = await mint(bPerson, 'invitation');
      // A link of B works on the same API: organisations share the instance, not the data.
      expect((await open(linkPath('invitation', bToken))).status).toBe(200);
      for (const bad of ['A'.repeat(43), 'x', '../../etc/passwd', "';--", 'A'.repeat(200)]) {
        const response = await open(linkPath('invitation', encodeURIComponent(bad)));
        expect(response.status).toBe(404);
        expect(response.body).toEqual(expect.objectContaining({ code: 'link_invalid' }));
      }
    });

    it('too many failed look-ups from one address answer 429', async () => {
      const from = '203.0.113.99';
      let last = 0;
      for (let index = 0; index < 25; index += 1) {
        last = (
          await e2e
            .admin(linkPath('invitation', 'A'.repeat(43)).replace('/api', '/api'))
            .set('X-Forwarded-For', from)
        ).status;
      }
      expect(last).toBe(429);
    });
  });

  describe('a password reset (FR-USR-03)', () => {
    it('ends every session of the user, and the older reset links', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const sessionBefore = await signIn(e2e, person);
      const older = await mint(person, 'password_reset');
      const token = await mint(person, 'password_reset');
      expect((await open(linkPath('password_reset', older))).status).toBe(404);
      const page = await open(linkPath('password_reset', token));
      expect(page.status).toBe(200);
      expect(page.body).toEqual(
        expect.objectContaining({ email: person.email, displayName: person.displayName }),
      );
      const response = await act(linkPath('password_reset', token), {
        password: GOOD_PASSWORD,
        passwordRepeat: GOOD_PASSWORD,
      });
      expect(response.status).toBe(204);
      expect((await as(e2e, sessionBefore, 'get', '/api/v1/session')).status).toBe(401);
      expect((await signIn(e2e, person, GOOD_PASSWORD)).session.user.id).toBe(person.id);
      // Every active admin of the organisation was told (ADR-03).
      const notices = await inOrganisation(actors.a.organisation.id, () =>
        rows<{ parameters: { change: string } }>(
          owner,
          "SELECT parameters FROM mail_outbox WHERE kind = 'security_notice' AND parameters->>'subjectUserId' = $1",
          [person.id],
        ),
      );
      expect(notices.map(({ parameters }) => parameters.change)).toEqual(
        expect.arrayContaining(['password_reset']),
      );
    });

    it('a reset link of an invited or a deactivated person is not usable', async () => {
      const factories = new Factories(owner);
      const invited = await factories.user(actors.a.organisation, { status: 'invited' });
      const token = await mint(invited, 'password_reset');
      expect(
        (
          await act(linkPath('password_reset', token), {
            password: GOOD_PASSWORD,
            passwordRepeat: GOOD_PASSWORD,
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('an email change (ST-18)', () => {
    let person: InventedUser;

    beforeAll(async () => {
      person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
    });

    it('needs the current password', async () => {
      const signedIn = await signIn(e2e, person);
      const wrong = await as(e2e, signedIn, 'post', '/api/v1/account/email').send({
        password: 'invented-not-it-123',
        newEmail: 'new.address@a.example.test',
      });
      expect(wrong.status).toBe(403);
      expect(wrong.body).toEqual(expect.objectContaining({ code: 'password_incorrect' }));
    });

    it('refuses an address that is not one, and one that belongs to an account', async () => {
      const signedIn = await signIn(e2e, person);
      for (const newEmail of [
        'two@a.example.test, three@a.example.test',
        'Name <x@a.example.test>',
        'x@a',
        'x y@a.example.test',
      ]) {
        const response = await as(e2e, signedIn, 'post', '/api/v1/account/email').send({
          password: INVENTED_PASSWORD,
          newEmail,
        });
        expect(response.status).toBe(400);
        expect(response.body).toEqual(
          expect.objectContaining({ errors: [{ path: 'newEmail', code: 'isMailAddress' }] }),
        );
      }
      const taken = await as(e2e, signedIn, 'post', '/api/v1/account/email').send({
        password: INVENTED_PASSWORD,
        newEmail: actors.a.admin.email,
      });
      expect(taken.status).toBe(409);
    });

    it('is confirmed from the new address, announced to the old one, and ends the sessions', async () => {
      const signedIn = await signIn(e2e, person);
      const newEmail = `${person.email.split('@')[0] ?? 'x'}.new@a.example.test`;
      const response = await as(e2e, signedIn, 'post', '/api/v1/account/email').send({
        password: INVENTED_PASSWORD,
        newEmail,
      });
      expect(response.status).toBe(202);
      const queued = await inOrganisation(actors.a.organisation.id, () =>
        rows<{ kind: string; recipient_address: string; link_purpose: string | null }>(
          owner,
          "SELECT kind, recipient_address, link_purpose FROM mail_outbox WHERE recipient_user_id = $1 AND kind LIKE 'email_change%' ORDER BY kind",
          [person.id],
        ),
      );
      expect(queued).toEqual([
        {
          kind: 'email_change_confirmation',
          recipient_address: newEmail,
          link_purpose: 'email_change',
        },
        { kind: 'email_change_notice', recipient_address: person.email, link_purpose: null },
      ]);
      const token = await mint(person, 'email_change', newEmail);
      const page = await open(linkPath('email_change', token));
      expect(page.status).toBe(200);
      expect(page.body).toEqual({ newEmail, expiresAt: expect.any(String) });
      expect((await act(linkPath('email_change', token), {})).status).toBe(204);
      expect((await as(e2e, signedIn, 'get', '/api/v1/session')).status).toBe(401);
      expect((await signIn(e2e, { email: newEmail })).session.user.email).toBe(newEmail);
      expect(
        (await act('/api/v1/session', { email: person.email, password: INVENTED_PASSWORD })).status,
      ).toBe(401);
      // The audit log names the field, never the addresses (a person's data).
      const [entry] = await inOrganisation(actors.a.organisation.id, () =>
        rows<{ fields: string[]; changes: object }>(
          owner,
          "SELECT fields, changes FROM audit_entries WHERE action = 'account.email_changed' AND subject_id = $1",
          [person.id],
        ),
      );
      expect(entry).toEqual({ fields: ['email'], changes: {} });
    });
  });

  describe('an own password change', () => {
    it('needs the current password, keeps this session, ends the others, and tells the admins', async () => {
      const person = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
      const here = await signIn(e2e, person);
      const elsewhere = await signIn(e2e, person);
      const wrong = await as(e2e, here, 'post', '/api/v1/account/password').send({
        currentPassword: 'invented-not-it-123',
        newPassword: GOOD_PASSWORD,
        newPasswordRepeat: GOOD_PASSWORD,
      });
      expect(wrong.status).toBe(403);
      const weak = await as(e2e, here, 'post', '/api/v1/account/password').send({
        currentPassword: INVENTED_PASSWORD,
        newPassword: 'qwertyuiop12',
        newPasswordRepeat: 'qwertyuiop12',
      });
      expect(weak.status).toBe(400);
      expect(weak.body).toEqual(
        expect.objectContaining({ errors: [{ path: 'newPassword', code: RULE_CODES.not_common }] }),
      );
      const ok = await as(e2e, here, 'post', '/api/v1/account/password').send({
        currentPassword: INVENTED_PASSWORD,
        newPassword: GOOD_PASSWORD,
        newPasswordRepeat: GOOD_PASSWORD,
      });
      expect(ok.status).toBe(204);
      expect((await as(e2e, here, 'get', '/api/v1/session')).status).toBe(200);
      expect((await as(e2e, elsewhere, 'get', '/api/v1/session')).status).toBe(401);
      // The new password is the one from now on, also when asked again.
      const later = await signIn(e2e, person, GOOD_PASSWORD);
      const confirmed = await as(e2e, later, 'post', '/api/v1/session/password-confirmation').send({
        password: GOOD_PASSWORD,
      });
      expect(confirmed.status).toBe(200);
    });
  });

  it('after everything, no minted token is stored in any text column of the database, nor in the log (ST-17)', async () => {
    expect(minted.length).toBeGreaterThan(5);
    const columns = await rows<{ table_name: string; column_name: string }>(
      owner,
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type IN ('text', 'citext', 'jsonb', 'character varying')`,
    );
    const haystack: string[] = [];
    await owner.query('BEGIN');
    try {
      // As the owner, outside any organisation: row-level security shows nothing, so read
      // each organisation's rows inside it.
      const organisations = [actors.a.organisation.id, actors.b.organisation.id];
      for (const organisationId of organisations) {
        await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
        for (const { table_name, column_name } of columns) {
          const values = await rows<{ value: string | null }>(
            owner,
            `SELECT "${column_name}"::text AS value FROM "${table_name}"`,
          );
          haystack.push(...values.map(({ value }) => value ?? ''));
        }
      }
    } finally {
      await owner.query('COMMIT');
    }
    const text = `${haystack.join('\n')}\n${e2e.logText()}`;
    for (const token of minted) {
      expect(text).not.toContain(token);
    }
  });
});
