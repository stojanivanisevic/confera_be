/**
 * Reads a `Host` header strictly (RFC 9110, section 7.2: `Host = uri-host [ ":" port ]`).
 *
 * The two surfaces of Confera are told apart by this header (ADR-02), so it must never
 * be "understood" generously. A lenient reader, such as a URL parser, finds the admin
 * host name inside `evil.example@admin.example.org`, `admin.example.org/x`,
 * `admin.example.org?x` or `%61dmin.example.org`. None of these is a host. This parser
 * accepts exactly:
 *
 *   - a DNS host name: labels of letters, digits and hyphens, separated by single dots,
 *     no trailing dot, no label starting or ending with a hyphen;
 *   - an IPv4 address (which has the same shape);
 *   - an IPv6 address in square brackets;
 *
 * each optionally followed by `:` and a port between 0 and 65535. Anything else is not a
 * host, and the caller answers it like a route that does not exist.
 */
export interface ParsedHost {
  /** The host name in lower case, an IPv6 address with its brackets. */
  readonly hostname: string;
  readonly port: number | undefined;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const IPV6 = /^\[[0-9a-f:.]{2,45}\]$/;
const PORT = /^[0-9]{1,5}$/;

/** The longest host name DNS allows. */
const MAX_NAME_LENGTH = 253;

export function parseHostHeader(header: string | undefined): ParsedHost | undefined {
  if (header === undefined || header === '' || header.length > MAX_NAME_LENGTH + 6) {
    return undefined;
  }
  const value = header.toLowerCase();

  let hostname = value;
  let port: number | undefined;
  // The port, if any, follows the last colon outside square brackets.
  const colon = value.lastIndexOf(':');
  if (colon > value.lastIndexOf(']')) {
    const digits = value.slice(colon + 1);
    if (!PORT.test(digits) || Number(digits) > 65535) {
      return undefined;
    }
    hostname = value.slice(0, colon);
    port = Number(digits);
  }

  if (hostname.startsWith('[')) {
    return IPV6.test(hostname) ? { hostname, port } : undefined;
  }
  if (hostname.length > MAX_NAME_LENGTH || !NAME.test(hostname)) {
    return undefined;
  }
  return { hostname, port };
}

/** True when `host` (as `URL.host` gives it) is something `parseHostHeader` can match. */
export function isMatchableHost(host: string): boolean {
  return parseHostHeader(host) !== undefined;
}
