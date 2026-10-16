import type { Client } from 'pg';
import { type Actors, as, createActors, signIn } from './support/actors';
import { ADMIN_HOST, type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories, INVENTED_PASSWORD } from './support/factories';

/**
 * E2-05 (ADR-03, SEC-A-14, ST-15): "a hammered account's owner still signs in from a known
 * browser". The password asked again is the same door for the person who is already signed
 * in, and it does not know their browser: `confirmPassword` passes `knownDevice: false`, so
 * five wrong sign-ins from anywhere (the address of the account is all it takes) make the
 * RIGHT password of the signed-in owner "incorrect" for the wait of the brake, and each such
 * try is counted and lengthens the wait. For that time the owner can change no user, no
 * role, no mail server and no bank detail.
 */
describe('the brake and the password asked again', () => {
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
    await owner.end();
  });

  const wrongSignIn = (email: string, from: string) =>
    e2e
      .http()
      .post('/api/v1/session')
      .set('Host', ADMIN_HOST)
      .set('Origin', e2e.config.origins.admin)
      .set('X-Forwarded-For', from)
      .send({ email, password: 'invented-wrong-guess-1' });

  it('does not take the right password from the signed-in owner while others hammer the account', async () => {
    const mine = await signIn(e2e, actors.a.admin);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await wrongSignIn(actors.a.admin.email, `203.0.113.${String(20 + attempt)}`);
    }
    const asked = await as(e2e, mine, 'post', '/api/v1/session/password-confirmation').send({
      password: INVENTED_PASSWORD,
    });
    expect(asked.status).toBe(200);
  });
});
