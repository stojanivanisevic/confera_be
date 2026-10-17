import { domainToASCII } from 'node:url';
import type { Stage } from '../../config/config.schema';

/**
 * The listed sites of a conference (FR-CONF-01, ADR-07, SEC-A-08; ST-30): the sites that
 * may embed its forms, from which the `frame-ancestors` header of 0.3.0 is built. Each
 * entry is parsed as a URL and kept as its origin only: scheme, host and port, lower case,
 * the host in punycode. Refused: a wildcard, a path, a query or fragment, a user part, a
 * space, a semicolon, a comma, a quote, `http:` outside a developer's own machine (STAGE
 * local), a loopback host (`localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`, `0.0.0.0`)
 * outside it too (SEC-M2-12), anything but http(s), and a 21st entry. The same origin twice
 * is kept once. The database checks the canonical form again (`listed_sites_are_origins`).
 */
export const MAX_LISTED_SITES = 20;

/** A host name in ASCII (punycode for an international one), or an IPv6 address in brackets. */
const CANONICAL_HOST =
  /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*|\[[0-9a-f:.]+\])$/;

/** The whole stored origin: scheme, host, port. Nothing else may be in it. */
const CANONICAL_ORIGIN = /^https?:\/\/[a-z0-9.:[\]-]+$/;

export type SiteProblem =
  | 'too_many'
  | 'not_a_url'
  | 'wildcard'
  | 'forbidden_character'
  | 'scheme'
  | 'user_part'
  | 'path'
  | 'query'
  | 'loopback';

export type SitesResult =
  | { readonly ok: true; readonly sites: string[] }
  | { readonly ok: false; readonly index: number; readonly problem: SiteProblem };

/** One entry as an origin, or what is wrong with it. */
export function normaliseSite(
  entry: string,
  stage: Stage,
): { ok: true; origin: string } | { ok: false; problem: SiteProblem } {
  const text = entry.trim();
  if (text.includes('*')) {
    return { ok: false, problem: 'wildcard' };
  }
  // A percent-escape is decoded by the URL parser after this check could see it: refused.
  if (text.includes('%')) {
    return { ok: false, problem: 'forbidden_character' };
  }
  // A space, a semicolon or comma (another directive or source), a quote, a control
  // character: nothing of that kind may reach a header.
  // eslint-disable-next-line no-control-regex
  if (/[\s;,'"`<>\\\u0000-\u001F\u007F]/.test(text)) {
    return { ok: false, problem: 'forbidden_character' };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return { ok: false, problem: 'not_a_url' };
  }
  if (scheme !== 'https' && !(scheme === 'http' && stage === 'local')) {
    return { ok: false, problem: 'scheme' };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, problem: 'not_a_url' };
  }
  if (url.username !== '' || url.password !== '' || text.slice(scheme.length + 3).includes('@')) {
    return { ok: false, problem: 'user_part' };
  }
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(text)) {
    return { ok: false, problem: 'query' };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { ok: false, problem: 'path' };
  }
  const host = url.hostname.startsWith('[') ? url.hostname : domainToASCII(url.hostname);
  // What is stored is checked, not only what was typed: the parser folds full-width and
  // other look-alike characters. The canonical origin is letters, digits, dots and hyphens
  // (or an IPv6 address in brackets), and a port; anything else never reaches a header.
  if (!CANONICAL_HOST.test(host)) {
    return { ok: false, problem: host === '' ? 'not_a_url' : 'forbidden_character' };
  }
  const origin = `${scheme}://${host}${url.port === '' ? '' : `:${url.port}`}`;
  if (!CANONICAL_ORIGIN.test(origin)) {
    return { ok: false, problem: 'forbidden_character' };
  }
  if (stage !== 'local' && isLoopbackHost(host)) {
    return { ok: false, problem: 'loopback' };
  }
  return { ok: true, origin };
}

/**
 * A host that names the machine itself: `localhost` and its subdomains, 127.0.0.0/8, the
 * unspecified addresses and `[::1]` (also an IPv4-mapped loopback). A conference site on
 * a server is never one (SEC-M2-12).
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(name) || name === '0.0.0.0') {
    return true;
  }
  if (name.startsWith('[')) {
    const inner = name.slice(1, -1);
    return (
      inner === '::1' ||
      inner === '::' ||
      /^(?:0{1,4}:){7}0{0,3}1$/.test(inner) ||
      /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(inner)
    );
  }
  return false;
}

/**
 * The listed sites as the frame page's `frame-ancestors` may name them (ADR-07, SEC-M2-12):
 * every stored entry checked again against the canonical origin, and against the rules of
 * the stage; whatever fails is dropped, never repaired. Built from stored values only.
 */
export function frameSites(stored: readonly string[], stage: Stage): string[] {
  const sites: string[] = [];
  for (const entry of stored.slice(0, MAX_LISTED_SITES)) {
    const checked = normaliseSite(entry, stage);
    if (checked.ok && checked.origin === entry && !sites.includes(entry)) {
      sites.push(entry);
    }
  }
  return sites;
}

/** The whole list: each entry normalised, duplicates dropped, at most 20. */
export function normaliseSites(entries: readonly string[], stage: Stage): SitesResult {
  if (entries.length > MAX_LISTED_SITES) {
    return { ok: false, index: MAX_LISTED_SITES, problem: 'too_many' };
  }
  const sites: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const result = normaliseSite(entry, stage);
    if (!result.ok) {
      return { ok: false, index, problem: result.problem };
    }
    if (!sites.includes(result.origin)) {
      sites.push(result.origin);
    }
  }
  return { ok: true, sites };
}

/** A time zone of the IANA database that this runtime knows. */
export function isTimeZone(value: string): boolean {
  // The shape of an IANA name (Area/Location, or UTC and the Etc names); the runtime then
  // says whether it knows the zone, aliases included (Asia/Kolkata, Europe/Kyiv).
  if (!/^(?:UTC|[A-Z][A-Za-z_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(value)) {
    return false;
  }
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}
