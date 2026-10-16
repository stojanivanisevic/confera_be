import type { Client } from 'pg';
import { BRAKE } from '../../src/modules/access/brake.service';
import { type Actors, as, createActors, type SignedIn, signIn } from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD } from './support/factories';

/**
 * SEC-M2-02: the password asked again is braked like a sign-in. After the free failures
 * of the account's own sessions the next attempt waits; a braked attempt is answered like
 * a wrong one, the right password included, and is not counted.
 */
describe('the brake of the password asked again (SEC-M2-02)', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM security_events');
  });

  const confirm = (session: SignedIn, password: string) =>
    as(e2e, session, 'post', '/api/v1/session/password-confirmation').send({ password });

  it('refuses the right password after the free failures, until the delay has passed', async () => {
    const user = await new Factories(owner).user(actors.a.organisation, { role: 'admin' });
    const session = await signIn(e2e, user);
    for (let attempt = 0; attempt < BRAKE.accountFreeFailures; attempt += 1) {
      expect((await confirm(session, 'invented-wrong-guess-1')).status).toBe(403);
    }
    const braked = await confirm(session, INVENTED_PASSWORD);
    expect(braked.status).toBe(403);
    expect(braked.body).toEqual(expect.objectContaining({ code: 'password_incorrect' }));

    // The delay of the brake passes.
    await owner.query(
      `UPDATE security_events SET occurred_at = occurred_at - make_interval(secs => $1)`,
      [BRAKE.firstDelayMs / 1000 + 1],
    );
    expect((await confirm(session, INVENTED_PASSWORD)).status).toBe(200);
  });

  it('forty guesses in one session do not reach the right password', async () => {
    const user = await new Factories(owner).user(actors.a.organisation, { role: 'admin' });
    const session = await signIn(e2e, user);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await confirm(session, `invented-wrong-guess-${String(attempt)}`);
    }
    expect((await confirm(session, INVENTED_PASSWORD)).status).toBe(403);
    // Braked attempts are not counted: the account has the free failures only.
    const [{ n } = { n: '0' }] = (
      await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM security_events WHERE kind = 'password_confirmation_failed' AND user_id = $1`,
        [user.id],
      )
    ).rows;
    expect(Number(n)).toBe(BRAKE.accountFreeFailures);
  });

  it('the brake of the address holds for the password asked again too', async () => {
    const user = await new Factories(owner).user(actors.a.organisation, { role: 'admin' });
    const session = await signIn(e2e, user);
    // Others' failed sign-ins from this address, beyond the free ones of the address.
    for (let attempt = 0; attempt < BRAKE.addressFreeFailures; attempt += 1) {
      await e2e
        .http()
        .post('/api/v1/session')
        .set('Host', 'admin.confera.test')
        .set('Origin', e2e.config.origins.admin)
        .send({ email: `nobody.${String(attempt)}@a.example.test`, password: 'invented-x' });
    }
    expect((await confirm(session, INVENTED_PASSWORD)).status).toBe(403);
  });
});
