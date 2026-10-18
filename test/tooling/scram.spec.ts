import { runNode } from '../support/run-node';

/**
 * M1-ISS-14 (SEC-M1-02): db:provision sends a role's SCRAM-SHA-256 verifier, never its
 * password, so a failing statement in the server's log holds no password. The integration
 * tests of db:provision sign in with the passwords afterwards: the verifier is the right one.
 */
async function verifiers(calls: [string, string | null][]): Promise<string[]> {
  const program = `
    import { scramVerifier } from './scripts/lib/scram.mjs';
    const calls = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(calls.map(([password, salt]) =>
      salt === null ? scramVerifier(password) : scramVerifier(password, Buffer.from(salt, 'base64')))));
  `;
  const run = await runNode(['--input-type=module', '--eval', program, JSON.stringify(calls)]);
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout) as string[];
}

describe('the SCRAM verifier of db:provision (M1-ISS-14)', () => {
  it('has the form PostgreSQL stores, holds no part of the password, and is salted afresh', async () => {
    const password = 'invented-provision-password-42';
    const [first, second] = await verifiers([
      [password, null],
      [password, null],
    ]);
    expect(first).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
    expect(first).not.toContain('invented');
    expect(second).not.toBe(first);
  });

  it('is the same for the same salt and differs for another password; PostgreSQL accepts it (test:int)', async () => {
    const salt = 'W22ZaJ0SNY7soEsUEjb6gQ==';
    const [one, again, other] = await verifiers([
      ['invented-first-password-1', salt],
      ['invented-first-password-1', salt],
      ['invented-other-password-2', salt],
    ]);
    expect(again).toBe(one);
    expect(other).not.toBe(one);
    expect(one?.startsWith(`SCRAM-SHA-256$4096:${salt}$`)).toBe(true);
  });
});
