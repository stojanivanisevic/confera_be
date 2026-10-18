// The SCRAM-SHA-256 verifier of a password (RFC 5802, RFC 7677), as PostgreSQL stores it
// (M1-ISS-14, SEC-M1-02). `db:provision` sends this verifier in `ALTER ROLE ... PASSWORD`,
// never the password: a statement that fails, and is written to the server's log with its
// text, holds no password then.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/** The iteration count PostgreSQL uses by default (scram_iterations). */
export const SCRAM_ITERATIONS = 4096;

/** `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, each part base64. */
export function scramVerifier(password, salt = randomBytes(16), iterations = SCRAM_ITERATIONS) {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
