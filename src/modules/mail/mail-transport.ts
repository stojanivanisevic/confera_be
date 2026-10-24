import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import type { Language } from '../templates/placeholders';
import { languageTag, mailDocument } from './mail-document';
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

/** An image of the message (ADR-12, M4-BE-06): an inline part, referenced as `cid:<cid>`. */
export interface InlineImage {
  readonly cid: string;
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface Delivery {
  readonly to: string;
  readonly subject: string;
  /** The rendered body; it is sent inside a whole document (mail-document.ts, UX4-03). */
  readonly html: string;
  readonly text: string;
  readonly images?: readonly InlineImage[];
  /** The language of the message: `lang` of the document and `Content-Language` (UX4-03). */
  readonly language?: Language;
  /** Where a reply goes (UX4-06): the organisation's contact address, when it has one. */
  readonly replyTo?: string | null;
}

/** The address every message of a staging instance goes to, inside the catcher (ST-50). */
export const CATCHER_RECIPIENT = 'catcher@staging.invalid';
/** The header that keeps the original recipient of a message diverted to the catcher. */
export const ORIGINAL_RECIPIENT_HEADER = 'X-Confera-Original-Recipient';
/** The mark of every subject of a staging instance. */
export const STAGING_MARK = '[STAGING]';

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

/** Where a delivery goes once the rules of its target were checked. */
interface Connection {
  readonly host: string;
  readonly port: number;
  readonly tlsMode: TlsMode;
  readonly servername: string | undefined;
  readonly auth: { user: string; pass: string } | undefined;
}

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

  /** Whether this instance diverts every message to its mail catcher (staging, ST-50). */
  get diverted(): boolean {
    return this.config.mail.stagingCatcher !== null;
  }

  /** Sends one message to one recipient. Never throws: the result says what happened. */
  async deliver(target: DeliveryTarget, delivery: Delivery): Promise<DeliveryResult> {
    // The rules of the target hold on staging too, so that an admin there meets what
    // production would answer; only the connection goes elsewhere.
    const problem = targetProblem(target, this.config.stage);
    if (problem !== null) {
      return { ok: false, error: problem };
    }
    const catcher = this.config.mail.stagingCatcher;
    let connection: Connection;
    if (catcher !== null) {
      // Staging (ADR-27, ST-50): the catcher of the server, on its private network, in clear
      // and without a login. The configured server is neither resolved nor reached.
      connection = {
        host: catcher.host,
        port: catcher.port,
        tlsMode: 'none',
        servername: undefined,
        auth: undefined,
      };
    } else {
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
      connection = {
        host: address,
        port: target.port,
        tlsMode: target.tlsMode,
        servername: isIP(target.host) === 0 ? target.host : undefined,
        auth:
          target.username === null
            ? undefined
            : { user: target.username, pass: target.password ?? '' },
      };
    }
    const transport = createTransport({
      host: connection.host,
      port: connection.port,
      secure: connection.tlsMode === 'implicit',
      requireTLS: connection.tlsMode === 'starttls',
      ignoreTLS: connection.tlsMode === 'none',
      tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        servername: connection.servername,
      },
      auth: connection.auth,
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
      const recipient = catcher === null ? delivery.to : CATCHER_RECIPIENT;
      const sending = transport.sendMail({
        from: { name: headerSafe(target.fromName), address: target.fromAddress },
        // On staging the original recipient is the display name and a header, never an
        // address of the envelope: no real domain can be reached through the catcher.
        to: [{ name: catcher === null ? '' : headerSafe(delivery.to), address: recipient }],
        envelope: { from: target.fromAddress, to: [recipient] },
        subject: headerSafe(
          catcher === null ? delivery.subject : `${STAGING_MARK} ${delivery.subject}`,
        ),
        headers: {
          'Content-Language': languageTag(delivery.language ?? 'en'),
          ...(catcher === null ? {} : { [ORIGINAL_RECIPIENT_HEADER]: headerSafe(delivery.to) }),
        },
        ...(delivery.replyTo === undefined || delivery.replyTo === null
          ? {}
          : { replyTo: { name: '', address: headerSafe(delivery.replyTo) } }),
        html: mailDocument(delivery.html, delivery.subject, delivery.language ?? 'en'),
        text: delivery.text,
        // Images travel inside the message (ADR-12): inline parts by content id, never a
        // remote address.
        attachments: (delivery.images ?? []).map((image) => ({
          cid: image.cid,
          filename: headerSafe(image.filename),
          contentType: image.contentType,
          content: image.content,
          contentDisposition: 'inline' as const,
        })),
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
