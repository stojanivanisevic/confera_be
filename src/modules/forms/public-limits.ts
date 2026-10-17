import { Injectable } from '@nestjs/common';
import { RateLimiter } from '../../common/http/rate-limiter';

/**
 * The limits of the public forms per source address (ADR-08, items 2 and 6; FR-FORM-12,
 * NFR-SEC-02), kept in the memory of the one API process: their loss at a restart costs
 * nothing. The address is the one-hop client address (ADR-03) and is never stored.
 *
 * - Hard limits: 30 token fetches in 10 minutes and 10 submits an hour per address; beyond
 *   them 429 `too_many_requests`.
 * - The proof-of-work switches itself on (P): more than 20 submissions in 10 minutes on one
 *   form (counted in the database), or more than 5 submits or 10 token fetches in 10
 *   minutes from one address.
 */
export const LIMITS = {
  tokensPerAddress: { limit: 30, windowMs: 10 * 60_000 },
  submitsPerAddress: { limit: 10, windowMs: 60 * 60_000 },
  powSubmitsPerAddress: { limit: 5, windowMs: 10 * 60_000 },
  powTokensPerAddress: { limit: 10, windowMs: 10 * 60_000 },
  powSubmissionsPerForm: { count: 20, windowMs: 10 * 60_000 },
  /** Uploads per address: at most this many in 10 minutes. */
  uploadsPerAddress: { limit: 40, windowMs: 10 * 60_000 },
} as const;

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
  readonly #powSubmits = new RateLimiter(
    LIMITS.powSubmitsPerAddress.limit,
    LIMITS.powSubmitsPerAddress.windowMs,
  );
  readonly #powTokens = new RateLimiter(
    LIMITS.powTokensPerAddress.limit,
    LIMITS.powTokensPerAddress.windowMs,
  );

  /** Counts a token fetch; false beyond the hard limit. */
  takeToken(address: string): boolean {
    this.#powTokens.take(address);
    return this.#tokens.take(address);
  }

  /** Counts a submit; false beyond the hard limit. */
  takeSubmit(address: string): boolean {
    this.#powSubmits.take(address);
    return this.#submits.take(address);
  }

  takeUpload(address: string): boolean {
    return this.#uploads.take(address);
  }

  /** Whether this address has sent so much that its next token asks for a proof-of-work. */
  addressUnderLoad(address: string): boolean {
    return this.#powSubmits.isOver(address) || this.#powTokens.isOver(address);
  }
}
