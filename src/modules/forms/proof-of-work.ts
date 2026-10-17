import { createHash, randomBytes } from 'node:crypto';

/**
 * The proof-of-work of the public forms (ADR-08, item 2): our own, behind the captcha
 * interface, off at normal rates. A form token issued under load carries a challenge and a
 * difficulty; the submit must then carry a counter (a decimal number as text) such that
 *
 *   SHA-256( UTF-8( challenge + ":" + counter ) )
 *
 * begins with at least `difficulty` zero bits. Nothing leaves Confera. The browser finds the
 * counter with Web Crypto; contracts/form-rule-vectors.json holds vectors for both sides.
 */
export const PROOF_OF_WORK_DIFFICULTY = 16;

/** A counter is at most 12 digits: enough for any difficulty this API asks. */
const COUNTER = /^(?:0|[1-9][0-9]{0,11})$/;

export function newChallenge(): string {
  return randomBytes(16).toString('hex');
}

function leadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function proofOfWorkHolds(challenge: string, difficulty: number, counter: unknown): boolean {
  if (typeof counter !== 'string' || !COUNTER.test(counter)) {
    return false;
  }
  const hash = createHash('sha256').update(`${challenge}:${counter}`, 'utf8').digest();
  return leadingZeroBits(hash) >= difficulty;
}

/** The smallest counter that answers a challenge (for the vectors and the tests). */
export function solveProofOfWork(challenge: string, difficulty: number): string {
  for (let counter = 0; ; counter += 1) {
    if (proofOfWorkHolds(challenge, difficulty, String(counter))) {
      return String(counter);
    }
  }
}
