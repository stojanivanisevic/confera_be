import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Random tokens of sessions, known devices and secure links (ADR-03, ADR-04): 32 random
 * bytes, written in base64url (43 characters). Only the SHA-256 of a token is stored; the
 * token itself exists in the cookie or in the email that carries it, and nowhere else.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** What is stored of a token: its SHA-256, hexadecimal. */
export function digestOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const CSRF_PURPOSE = 'confera.csrf.v1';

/**
 * The CSRF value of a session (ADR-03: "a session-bound CSRF header"): an HMAC of a fixed
 * text under the session's own token. It is bound to that session, needs no key of its
 * own and no storage, and never lives in a cookie. Whoever does not hold the session
 * token (an HttpOnly cookie) cannot compute it.
 */
export function csrfValueOf(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_PURPOSE).digest('base64url');
}

/** Compares two texts in a time that does not depend on where they differ. */
export function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
