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
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) {
      return isRefusedAddress(mapped[1]);
    }
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) || // unique local
      /^fe[89ab]/.test(lower) || // link-local
      lower.startsWith('ff') // multicast
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
