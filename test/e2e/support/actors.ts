import type { Client } from 'pg';
import request from 'supertest';
import { SESSION_COOKIE } from '../../../src/modules/access/cookies';
import type { SessionDto } from '../../../src/modules/access/access.dto';
import { digestOf } from '../../../src/modules/access/tokens';
import { ADMIN_HOST, type E2eApp } from './e2e-app';
import {
  Factories,
  INVENTED_PASSWORD,
  type InventedOrganisation,
  type InventedUser,
} from './factories';

/**
 * The actors of the end-to-end tests of 0.2.0 (ADR-24: "an authorisation matrix ... for
 * five actors"), on the two-organisation fixture (FR-ORG-01, M2-BE-05):
 *
 *   anonymous      nobody signed in
 *   adminA         an admin of organisation A
 *   reviewerA      a reviewer of organisation A
 *   adminB         an admin of organisation B: every object of A is foreign to them
 *   endedA         an admin of A whose session was ended (signed out everywhere)
 *
 * A signed-in actor holds the session cookie and the CSRF value of its session; `as()`
 * sends them. Every request goes under the admin host name with the admin origin, as the
 * web application sends it.
 */
export type ActorName = 'anonymous' | 'adminA' | 'reviewerA' | 'adminB' | 'endedA';

export interface SignedIn {
  readonly cookie: string;
  readonly csrf: string;
  readonly session: SessionDto;
  /** Every Set-Cookie line of the sign-in answer. */
  readonly setCookies: readonly string[];
  /** What the table holds of the token: its SHA-256. For a test that reads the row. */
  readonly tokenHash: string;
}

export interface Actors {
  readonly a: {
    organisation: InventedOrganisation;
    admin: InventedUser;
    reviewer: InventedUser;
    ended: InventedUser;
  };
  readonly b: { organisation: InventedOrganisation; admin: InventedUser; reviewer: InventedUser };
  readonly sessions: Readonly<Record<Exclude<ActorName, 'anonymous'>, SignedIn>>;
}

/** The value of the session cookie in a Set-Cookie line, or null. */
export function sessionCookieOf(setCookies: readonly string[]): string | null {
  const line = setCookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (line === undefined) {
    return null;
  }
  const value = line.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? '';
  return value === '' ? null : value;
}

function setCookiesOf(response: request.Response): string[] {
  const header = response.headers['set-cookie'] as string | string[] | undefined;
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}

/** Signs a person in and returns what the browser would keep. Throws when sign-in fails. */
export async function signIn(
  e2e: E2eApp,
  user: Pick<InventedUser, 'email'>,
  password = INVENTED_PASSWORD,
  options: { cookies?: string } = {},
): Promise<SignedIn> {
  const response = await e2e
    .http()
    .post('/api/v1/session')
    .set('Host', ADMIN_HOST)
    .set('Origin', e2e.config.origins.admin)
    .set('Cookie', options.cookies ?? '')
    .send({ email: user.email, password });
  if (response.status !== 200) {
    throw new Error(
      `sign-in of ${user.email} answered ${String(response.status)}: ${response.text}`,
    );
  }
  const setCookies = setCookiesOf(response);
  const token = sessionCookieOf(setCookies);
  if (token === null) {
    throw new Error('sign-in set no session cookie');
  }
  const session = response.body as SessionDto;
  return {
    cookie: `${SESSION_COOKIE}=${token}`,
    csrf: session.csrf,
    session,
    setCookies,
    tokenHash: digestOf(token),
  };
}

/** A request as an actor: the cookie, the CSRF header, the admin host and origin. */
export function as(
  e2e: E2eApp,
  signedIn: SignedIn | null,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
): request.Test {
  let test = e2e
    .http()
    [method](path)
    .set('Host', ADMIN_HOST)
    .set('Origin', e2e.config.origins.admin);
  if (signedIn !== null) {
    test = test.set('Cookie', signedIn.cookie).set('X-CSRF-Token', signedIn.csrf);
  }
  return test;
}

/** The password asked again for the session: what every sensitive change needs first. */
export async function confirmPassword(e2e: E2eApp, signedIn: SignedIn): Promise<void> {
  const response = await as(e2e, signedIn, 'post', '/api/v1/session/password-confirmation').send({
    password: INVENTED_PASSWORD,
  });
  if (response.status !== 200) {
    throw new Error(`password confirmation answered ${String(response.status)}: ${response.text}`);
  }
}

/** Writes the two organisations with their people and signs the actors in. */
export async function createActors(e2e: E2eApp, owner: Client): Promise<Actors> {
  const factories = new Factories(owner);
  const organisationA = await factories.organisation();
  const organisationB = await factories.organisation();
  const a = {
    organisation: organisationA,
    admin: await factories.user(organisationA, { role: 'admin' }),
    reviewer: await factories.user(organisationA, { role: 'reviewer' }),
    ended: await factories.user(organisationA, { role: 'admin' }),
  };
  const b = {
    organisation: organisationB,
    admin: await factories.user(organisationB, { role: 'admin' }),
    reviewer: await factories.user(organisationB, { role: 'reviewer' }),
  };
  const endedA = await signIn(e2e, a.ended);
  await as(e2e, endedA, 'delete', '/api/v1/sessions').expect(204);
  return {
    a,
    b,
    sessions: {
      adminA: await signIn(e2e, a.admin),
      reviewerA: await signIn(e2e, a.reviewer),
      adminB: await signIn(e2e, b.admin),
      endedA,
    },
  };
}
