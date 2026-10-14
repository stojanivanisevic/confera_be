import type { Client } from 'pg';
import { runNode } from '../support/run-node';
import { connectAsSuperuser, rows } from './support/database';

/**
 * db:provision after an interrupted DROP DATABASE (the cause of the second failure of
 * db-provision.edge.spec.ts in the verification of E8): PostgreSQL 16 and later leave the
 * database behind marked invalid, nobody can connect to it (55000), and a run that only
 * creates what is missing failed on it for ever, with a message about the stack.
 */

const DATABASE = 'confera_recovery_test';

describe('db:provision after an interrupted DROP DATABASE', () => {
  jest.setTimeout(120_000);

  let superuser: Client;

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
    await superuser.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await superuser.query(`CREATE DATABASE ${DATABASE}`);
    // What an interrupted DROP DATABASE leaves behind.
    await superuser.query(`UPDATE pg_database SET datconnlimit = -2 WHERE datname = '${DATABASE}'`);
  });

  afterAll(async () => {
    await superuser.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await superuser.end();
  });

  it('drops the invalid database, creates it again, and says so', async () => {
    const result = await runNode(['scripts/db-provision.mjs', '--database', DATABASE], {
      timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Database "${DATABASE}" was left invalid by an interrupted DROP DATABASE; it is dropped and created again.`,
    );
    expect(result.stdout).toContain(`Database "${DATABASE}" is provisioned.`);
    const state = await rows<{ datconnlimit: number }>(
      superuser,
      'SELECT datconnlimit FROM pg_database WHERE datname = $1',
      [DATABASE],
    );
    expect(state).toEqual([{ datconnlimit: -1 }]);
  });
});
