import { Injectable } from '@nestjs/common';
import { hash, type Options, verify } from '@node-rs/argon2';
import { newToken } from './tokens';

/**
 * Passwords are stored as argon2id hashes (ADR-03, NFR-SEC-07), with the parameters of the
 * OWASP recommendation: 19 MiB of memory, 2 passes, 1 lane. The work runs on the thread
 * pool of libuv, not on the event loop.
 */
/** Algorithm.Argon2id of the binding: an ambient const enum, which isolatedModules cannot read. */
const ARGON2ID = 2;

export const HASH_OPTIONS: Options = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordHasher {
  /**
   * A hash of a random text, made at start: what an account without a password (unknown,
   * invited, braked) is checked against, so that every answer of sign-in costs one hash
   * (ST-16: equal in time).
   */
  readonly #dummy: Promise<string> = hash(newToken(), HASH_OPTIONS);

  /** Passwords are hashed and checked in NFC (FR-USR-06; NIST SP 800-63B). */
  hash(password: string): Promise<string> {
    return hash(password.normalize('NFC'), HASH_OPTIONS);
  }

  /** True when the password is the one of the stored hash. Null: compare with nothing, and fail. */
  async matches(stored: string | null, password: string): Promise<boolean> {
    const normalised = password.normalize('NFC');
    if (stored === null) {
      await verify(await this.#dummy, normalised).catch(() => false);
      return false;
    }
    try {
      return await verify(stored, normalised);
    } catch {
      return false;
    }
  }
}
