import type { Client } from 'pg';
import { type Actors, as, createActors, signIn } from './support/actors';
import { ADMIN_HOST, type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD } from './support/factories';
import { linkPath, mintLink } from './support/links';

/**
 * Edge cases of the secure links (ADR-03, ADR-04; ST-17, ST-18) found by the edge-case
 * hunter. Each test fails today, for the reason in its comment.
 */
describe('secure links across other changes of the account', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  const NEW_PASSWORD = 'invented-Nova-Lozinka-Reka-91';

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

  const post = (path: string) =>
    e2e.http().post(path).set('Host', ADMIN_HOST).set('Origin', e2e.config.origins.admin);

  /** A person who has asked for an email change, and the link the sender mails to the new address. */
  async function pendingEmailChange() {
    const user = await new Factories(owner).user(actors.a.organisation, { role: 'reviewer' });
    const session = await signIn(e2e, user);
    const newEmail = `novi.${Date.now().toString(36)}.${user.id.slice(0, 4)}@a.example.test`;
    const asked = await as(e2e, session, 'post', '/api/v1/account/email').send({
      password: INVENTED_PASSWORD,
      newEmail,
    });
    expect(asked.status).toBe(202);
    const token = await mintLink(e2e, {
      organisationId: actors.a.organisation.id,
      purpose: 'email_change',
      userId: user.id,
      recipient: newEmail,
    });
    return { user, session, newEmail, token };
  }

  // E2-03. ADR-03: the email change "needs the current password"; an own password change, a
  // reset or an email change end sessions because the password may be known to someone else.
  // A person who finds that their password is known resets it. The link that somebody asked
  // for under the OLD password, to THEIR address, is still open for 30 minutes, and
  // confirming it moves the account to that address (from where a reset takes it over).
  // `setPasswordByLink` and `changePassword` revoke only the reset links.
  it('a reset of the password ends an email change asked for before it', async () => {
    const { user, newEmail, token } = await pendingEmailChange();
    const reset = await mintLink(e2e, {
      organisationId: actors.a.organisation.id,
      purpose: 'password_reset',
      userId: user.id,
      recipient: user.email,
    });
    const done = await post(linkPath('password_reset', reset)).send({
      password: NEW_PASSWORD,
      passwordRepeat: NEW_PASSWORD,
    });
    expect(done.status).toBe(204);

    const confirmed = await post(linkPath('email_change', token));
    expect(confirmed.status).toBe(404);
    expect(confirmed.body).toEqual(expect.objectContaining({ code: 'link_invalid' }));
    // The account still has its own address.
    const again = await signIn(e2e, { email: user.email }, NEW_PASSWORD);
    expect(again.session.user.email).toBe(user.email);
    expect(again.session.user.email).not.toBe(newEmail);
  });

  it('an own change of the password ends an email change asked for before it', async () => {
    const { session, token } = await pendingEmailChange();
    const changed = await as(e2e, session, 'post', '/api/v1/account/password').send({
      currentPassword: INVENTED_PASSWORD,
      newPassword: NEW_PASSWORD,
      newPasswordRepeat: NEW_PASSWORD,
    });
    expect(changed.status).toBe(204);

    const confirmed = await post(linkPath('email_change', token));
    expect(confirmed.status).toBe(404);
    expect(confirmed.body).toEqual(expect.objectContaining({ code: 'link_invalid' }));
  });

  // E2-15. The check "is the address taken?" runs before the transaction that moves the
  // account, and the address is unique across the instance (ADR-06). Two people who confirm
  // the same new address at the same moment: the second one meets the unique key and gets
  // 500 instead of the 409 `email_taken` that the sequential case gets (the Test engineer's
  // case "an email change that meets an invitation").
  it('two people confirming the same address at once: one wins, the other is told it is taken', async () => {
    const outcomes: [number, number][] = [];
    for (let round = 0; round < 4; round += 1) {
      const factories = new Factories(owner);
      const first = await factories.user(actors.a.organisation, { role: 'reviewer' });
      const second = await factories.user(actors.b.organisation, { role: 'reviewer' });
      const target = `isti.${String(round)}.${Date.now().toString(36)}@a.example.test`;
      const tokenOne = await mintLink(e2e, {
        organisationId: actors.a.organisation.id,
        purpose: 'email_change',
        userId: first.id,
        recipient: target,
      });
      const tokenTwo = await mintLink(e2e, {
        organisationId: actors.b.organisation.id,
        purpose: 'email_change',
        userId: second.id,
        recipient: target,
      });
      const [one, two] = await Promise.all([
        post(linkPath('email_change', tokenOne)),
        post(linkPath('email_change', tokenTwo)),
      ]);
      outcomes.push([one.status, two.status]);
    }
    for (const [one, two] of outcomes) {
      expect([one, two].sort()).toEqual([204, 409]);
    }
  });
});
