import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import { isRefusedAddress, type TlsMode, targetProblem } from '../mail-servers/mail-server-policy';

/**
 * One SMTP delivery (ADR-11, ADR-13; ST-20, ST-23). A transport is made for each delivery
 * from the server row as it is now, so that a change of a server takes effect with the
 * next message, without a restart (FR-SMTP-03).
 *
 * - TLS is required with at least TLS 1.2 and a verified certificate; `starttls` refuses
 *   a server that does not offer it. Only `none`, on a developer machine, sends in clear.
 * - On a server the host name is resolved here, every address is checked (no loopback,
 *   private or container network), and the connection goes to the checked address with
 *   the host name for the certificate: a name that resolves elsewhere later is not used.
 * - Exactly one recipient, passed as a structured value; the sender name loses its
 *   control characters. Never a header built from a string.
 */
export interface DeliveryTarget {
  readonly host: string;
  readonly port: number;
  readonly tlsMode: TlsMode;
  readonly username: string | null;
  readonly password: string | null;
  readonly fromAddress: string;
  readonly fromName: string;
}

export interface Delivery {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** How a host name becomes addresses: the system's resolver, or a test's (SEC-M2-13). */
export type HostLookup = (host: string) => Promise<readonly { address: string }[]>;

/** The token of a lookup other than the system's. Only tests provide one. */
export const MAIL_LOOKUP = Symbol('MAIL_LOOKUP');

const systemLookup: HostLookup = (host) => lookup(host, { all: true, verbatim: true });

/** Why a delivery failed: a code, never the server's words (they may hold an address or a secret). */
export type DeliveryError =
  | 'tls_required'
  | 'certificate_refused'
  | 'address_not_allowed'
  | 'port_not_allowed'
  | 'connection_failed'
  | 'authentication_failed'
  | 'recipient_refused'
  | 'timeout'
  | 'send_failed';

export type DeliveryResult =
  { readonly ok: true } | { readonly ok: false; readonly error: DeliveryError };

/** Seconds a delivery may take at each step; a hanging server never holds the worker. */
const TIMEOUT_MS = 15_000;

/**
 * The whole of one delivery, however the server dribbles its answers: the timeouts above
 * are of inactivity, and a server that answers a little every few seconds never trips them.
 */
export const DELIVERY_DEADLINE_MS = 45_000;

const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A name as a header value: no control or line-separator character survives. */
export function headerSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/gu, ' ').trim();
}

/** Turns what the mail library threw into a code. */
export function deliveryErrorOf(error: unknown): DeliveryError {
  const record = (error ?? {}) as {
    code?: unknown;
    cause?: { code?: unknown };
    message?: unknown;
    responseCode?: unknown;
  };
  const codes = [record.code, record.cause?.code].filter((code) => typeof code === 'string');
  const message = typeof record.message === 'string' ? record.message : '';
  if (
    codes.some((code) => CERTIFICATE_CODES.has(code)) ||
    /certificate|self[- ]signed/i.test(message)
  ) {
    return 'certificate_refused';
  }
  if (codes.includes('ETLS') || /STARTTLS/i.test(message)) {
    return 'tls_required';
  }
  if (codes.includes('EAUTH')) {
    return 'authentication_failed';
  }
  if (codes.includes('EENVELOPE')) {
    return 'recipient_refused';
  }
  if (codes.some((code) => code === 'ETIMEDOUT' || code === 'ETIMEOUT')) {
    return 'timeout';
  }
  if (
    codes.some((code) =>
      ['ECONNECTION', 'ECONNREFUSED', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(code),
    )
  ) {
    return 'connection_failed';
  }
  return 'send_failed';
}

@Injectable()
export class MailTransport {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(MAIL_LOOKUP) private readonly lookupAll: HostLookup = systemLookup,
  ) {}

  /** Sends one message to one recipient. Never throws: the result says what happened. */
  async deliver(target: DeliveryTarget, delivery: Delivery): Promise<DeliveryResult> {
    const problem = targetProblem(target, this.config.stage);
    if (problem !== null) {
      return { ok: false, error: problem };
    }
    let address = target.host;
    if (this.config.stage === 'prod') {
      const resolved = await this.resolve(target.host);
      if (resolved === null) {
        return { ok: false, error: 'connection_failed' };
      }
      if (resolved.some((entry) => isRefusedAddress(entry))) {
        return { ok: false, error: 'address_not_allowed' };
      }
      address = resolved[0] ?? target.host;
    }
    const transport = createTransport({
      host: address,
      port: target.port,
      secure: target.tlsMode === 'implicit',
      requireTLS: target.tlsMode === 'starttls',
      ignoreTLS: target.tlsMode === 'none',
      tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        servername: isIP(target.host) === 0 ? target.host : undefined,
      },
      auth:
        target.username === null
          ? undefined
          : { user: target.username, pass: target.password ?? '' },
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }));
      }, DELIVERY_DEADLINE_MS);
    });
    try {
      const sending = transport.sendMail({
        from: { name: headerSafe(target.fromName), address: target.fromAddress },
        to: [{ name: '', address: delivery.to }],
        envelope: { from: target.fromAddress, to: [delivery.to] },
        subject: headerSafe(delivery.subject),
        html: delivery.html,
        text: delivery.text,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      sending.catch(() => undefined);
      await Promise.race([sending, deadline]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: deliveryErrorOf(error) };
    } finally {
      clearTimeout(timer);
      transport.close();
    }
  }

  private async resolve(host: string): Promise<string[] | null> {
    const bare = host.replace(/^\[|\]$/g, '');
    if (isIP(bare) !== 0) {
      return [bare];
    }
    try {
      const entries = await this.lookupAll(bare);
      return entries.length === 0 ? null : entries.map((entry) => entry.address);
    } catch {
      return null;
    }
  }
}
