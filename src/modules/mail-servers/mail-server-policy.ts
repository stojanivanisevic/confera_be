import { isIP } from 'node:net';
import type { Stage } from '../../config/config.schema';

/**
 * The rules of a mail server's target (ADR-11, SEC-A-18, ST-20), as pure functions:
 *
 * - TLS is required: `implicit` (TLS from the first byte) or `starttls` (refused when the
 *   server offers none). `none` exists for the mail catcher of a developer machine and is
 *   refused unless STAGE is local, dev or test.
 * - On a server (STAGE=prod) a target may not be a loopback, private, link-local or
 *   container-network address, and only the mail ports are allowed; the same check runs
 *   again on every address the host name resolves to, at the moment of connecting.
 * - The order in which servers are chosen for a message (FR-SMTP-02).
 */
export const TLS_MODES = ['implicit', 'starttls', 'none'] as const;
export type TlsMode = (typeof TLS_MODES)[number];

/** The ports of mail submission and relay. On a server no other port is allowed. */
export const MAIL_PORTS: readonly number[] = [25, 465, 587, 2525];

/** The stages on which a server without TLS (the mail catcher) may be used. */
const PLAIN_STAGES: readonly Stage[] = ['local', 'dev', 'test'];

export type TargetProblem = 'tls_required' | 'port_not_allowed' | 'address_not_allowed';

/** The host names that always mean this machine or its container network. */
const LOCAL_NAMES =
  /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback|host\.docker\.internal|gateway\.docker\.internal)$|\.(localhost|internal|local)$/i;

function ipv4Parts(address: string): number[] {
  return address.split('.').map(Number);
}

/**
 * The eight 16-bit words of an IPv6 address, whatever its spelling (full, zero-padded,
 * compressed, with a dotted IPv4 tail), or null. Every spelling is checked as one address.
 */
export function ipv6Words(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone >= 0) {
    text = text.slice(0, zone);
  }
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const parts = dotted.slice(1).map(Number);
    if (parts.some((part) => part > 255)) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = parts;
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parse = (half: string | undefined) =>
    half === undefined || half === '' ? [] : half.split(':');
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }
  const words = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
    return null;
  }
  return words.map((word) => parseInt(word, 16));
}

/** Whether an IP address is one no mail server of a server stage may have (SEC-A-18). */
export function isRefusedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = ipv4Parts(address);
    return (
      a === 0 || // this network
      a === 10 || // private
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // private, Docker's networks
      (a === 192 && b === 168) || // private
      (a === 192 && b === 0) || // IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast and reserved
    );
  }
  if (version === 6) {
    const words = ipv6Words(address);
    if (words === null) {
      return true;
    }
    const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
    const embedded = `${String(w6 >> 8)}.${String(w6 & 255)}.${String(w7 >> 8)}.${String(w7 & 255)}`;
    const firstFive = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0;
    // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), translated
    // (::ffff:0:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) reach the IPv4 address.
    if (
      (firstFive && (w5 === 0xffff || w5 === 0)) ||
      (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) ||
      (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0)
    ) {
      // ::, ::1 and every other ::a.b.c.d land here; 0.x.x.x is refused as "this network".
      return isRefusedAddress(embedded);
    }
    return (
      (w0 & 0xfe00) === 0xfc00 || // unique local
      (w0 & 0xffc0) === 0xfe80 || // link-local
      (w0 & 0xffc0) === 0xfec0 || // site-local (deprecated)
      (w0 & 0xff00) === 0xff00 // multicast
    );
  }
  return true;
}

/** What is wrong with a target on this stage, or null. A host name is checked again when resolved. */
export function targetProblem(
  target: { host: string; port: number; tlsMode: TlsMode },
  stage: Stage,
): TargetProblem | null {
  if (target.tlsMode === 'none' && !PLAIN_STAGES.includes(stage)) {
    return 'tls_required';
  }
  if (stage !== 'prod') {
    return null;
  }
  if (!MAIL_PORTS.includes(target.port)) {
    return 'port_not_allowed';
  }
  const host = target.host.replace(/^\[|\]$/g, '');
  if (LOCAL_NAMES.test(host) || (isIP(host) !== 0 && isRefusedAddress(host))) {
    return 'address_not_allowed';
  }
  // A single label (no dot) is a name of the container network, never a mail provider.
  if (isIP(host) === 0 && !host.includes('.')) {
    return 'address_not_allowed';
  }
  return null;
}

/** A host name: labels of letters, digits and hyphens, or an IP address. No user part, port or path. */
export function isHostName(value: string): boolean {
  if (isIP(value.replace(/^\[|\]$/g, '')) !== 0) {
    return true;
  }
  return (
    value.length <= 253 &&
    value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
}

export interface SelectableServer {
  readonly id: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly isFallback: boolean;
}

/**
 * The servers a message is sent through, in order (FR-SMTP-02, ADR-11): the one set on the
 * template, else the one set on the conference, else the organisation's default; then the
 * fallback, when there is one and it is another server. A server that is switched off is
 * passed over at its level. Empty when nothing is configured.
 */
export function chooseServers<T extends SelectableServer>(
  servers: readonly T[],
  choice: { templateServerId?: string | null; conferenceServerId?: string | null },
): T[] {
  const usable = (id: string | null | undefined) =>
    id === null || id === undefined
      ? undefined
      : servers.find((server) => server.id === id && server.enabled);
  const primary =
    usable(choice.templateServerId) ??
    usable(choice.conferenceServerId) ??
    servers.find((server) => server.isDefault && server.enabled);
  const fallback = servers.find(
    (server) => server.isFallback && server.enabled && server.id !== primary?.id,
  );
  return [primary, fallback].filter((server): server is T => server !== undefined);
}
