import type { Request, Response } from 'express';
import { isToken } from './tokens';

/**
 * The two cookies of Confera (ADR-03, SEC-A-50, ST-13, ST-66). Both carry the `__Host-`
 * prefix, which a browser accepts only from the host itself, with `Secure`, `Path=/` and
 * no `Domain`: a page of the public host (or any other host of the parent domain) cannot
 * set or overwrite them. The API reads exactly these names and nothing else, so a cookie
 * planted for the parent domain under another name is ignored. No CSRF value lives in a
 * cookie.
 */
export const SESSION_COOKIE = '__Host-confera_session';
export const DEVICE_COOKIE = '__Host-confera_device';

/** A known device stays known for a year after its last sign-in. */
export const DEVICE_COOKIE_SECONDS = 365 * 24 * 60 * 60;

/**
 * The value of a cookie of the request, or null when it is absent, sent twice, or not a
 * token: a request that carries two cookies of one name (one of them planted) has none.
 */
export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (header === undefined) {
    return null;
  }
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  const [value] = values;
  return values.length === 1 && value !== undefined && isToken(value) ? value : null;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}; HttpOnly; Secure; SameSite=Lax`;
}

export function setCookie(
  response: Response,
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  response.append('Set-Cookie', cookie(name, value, maxAgeSeconds));
}

export function clearCookie(response: Response, name: string): void {
  response.append('Set-Cookie', cookie(name, '', 0));
}
