import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import { RateLimiter } from '../../common/http/rate-limiter';

/**
 * The limits of the public forms per client (ADR-08, items 2 and 6; FR-FORM-12,
 * NFR-SEC-02), kept in the memory of the one API process: their loss at a restart costs
 * nothing. A client is the one-hop client address (ADR-03), and for IPv6 its /64 (Q3-03):
 * one household or machine has a whole /64 and would otherwise be a new client per address.
 * The address is never stored.
 *
 * - Hard limits: 30 token fetches in 10 minutes and 10 submits an hour per client; beyond
 *   them 429 `too_many_requests`.
 * - The proof-of-work (Q3-08) switches itself on for a client that behaves like a script:
 *   3 suspicious acts in 10 minutes (the trap filled, a submit faster than a person, a
 *   proof-of-work that fails, a token that is not valid). Volume alone from one address
 *   does not: a faculty behind one address on its deadline hour is many authors. On the
 *   form as a whole it switches on above 20 submissions in 10 minutes (counted in the
 *   database).
 */
export const LIMITS = {
  tokensPerAddress: { limit: 30, windowMs: 10 * 60_000 },
  submitsPerAddress: { limit: 10, windowMs: 60 * 60_000 },
  suspiciousPerAddress: { limit: 3, windowMs: 10 * 60_000 },
  powSubmissionsPerForm: { count: 20, windowMs: 10 * 60_000 },
  /** Uploads per client: at most this many in 10 minutes. */
  uploadsPerAddress: { limit: 40, windowMs: 10 * 60_000 },
  /**
   * Bytes of kept uploads per client (SEC-M3-02): at most half the quota of unattached bytes
   * of an organisation in the 30 hours an unattached file may live, so one client alone
   * cannot hold the quota. A faculty behind one address still has room for many authors.
   */
  uploadBytesPerAddress: { limit: 1024 * 1024 * 1024, windowMs: 30 * 60 * 60_000 },
} as const;

/** The client an address belongs to: an IPv4 address, or the /64 of an IPv6 address (Q3-03). */
export function clientKey(address: string): string {
  const plain = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(plain);
  if (mapped?.[1] !== undefined) {
    return mapped[1];
  }
  if (isIP(plain) !== 6) {
    return plain;
  }
  // Expand :: into the missing groups, then keep the first four.
  const [head = '', tail = ''] = plain.toLowerCase().split('::');
  const left = head === '' ? [] : head.split(':');
  const right = plain.includes('::') ? (tail === '' ? [] : tail.split(':')) : [];
  // An embedded IPv4 tail other than `::ffff:` (unwrapped above) counts here as one group,
  // not the two it stands for, so such a spelling may be keyed one group off. Node gives the
  // client address in its canonical form, which never ends so (SEC-M3-09).
  const groups = [
    ...left,
    ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
    ...right,
  ];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

@Injectable()
export class PublicLimits {
  readonly #tokens = new RateLimiter(
    LIMITS.tokensPerAddress.limit,
    LIMITS.tokensPerAddress.windowMs,
  );
  readonly #submits = new RateLimiter(
    LIMITS.submitsPerAddress.limit,
    LIMITS.submitsPerAddress.windowMs,
  );
  readonly #uploads = new RateLimiter(
    LIMITS.uploadsPerAddress.limit,
    LIMITS.uploadsPerAddress.windowMs,
  );
  readonly #uploadBytes = new RateLimiter(
    LIMITS.uploadBytesPerAddress.limit,
    LIMITS.uploadBytesPerAddress.windowMs,
  );
  readonly #suspicious = new RateLimiter(
    LIMITS.suspiciousPerAddress.limit,
    LIMITS.suspiciousPerAddress.windowMs,
  );

  /** Counts a token fetch; false beyond the hard limit. */
  takeToken(address: string): boolean {
    return this.#tokens.take(clientKey(address));
  }

  /** Counts a submit; false beyond the hard limit. */
  takeSubmit(address: string): boolean {
    return this.#submits.take(clientKey(address));
  }

  takeUpload(address: string): boolean {
    return this.#uploads.take(clientKey(address));
  }

  /** The bytes this client may still upload (SEC-M3-02). Counts nothing. */
  uploadBytesLeft(address: string): number {
    return Math.max(0, this.#uploadBytes.limit - this.#uploadBytes.used(clientKey(address)));
  }

  /** Counts the bytes of a kept upload: a refused one counts none (Q3-04). */
  keptUploadBytes(address: string, bytes: number): void {
    this.#uploadBytes.take(clientKey(address), bytes);
  }

  /** Counts an act of a script: the trap, a submit too fast, a failed proof, a token not valid. */
  suspicious(address: string): void {
    this.#suspicious.take(clientKey(address));
  }

  /** Whether this client behaved so like a script that its tokens ask for a proof-of-work. */
  addressUnderLoad(address: string): boolean {
    return this.#suspicious.isOver(clientKey(address));
  }
}
