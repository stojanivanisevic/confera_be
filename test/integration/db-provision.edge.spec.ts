import type { Client } from 'pg';
import { runNode } from '../support/run-node';
import { connectAsSuperuser } from './support/database';

/**
 * Edge case found by the edge-case hunter (M1-REV-01): two `db:provision` at once.
 *
 * prepare-database.ts: "Each test tier has a database of its own, so the tiers cannot
 * disturb each other". They share the three roles, though, and every run of
 * `db:provision` alters them (`ALTER ROLE ... PASSWORD`, `ALTER ROLE ... SET`, `REVOKE`).
 * Two runs at the same moment, for two different databases, make PostgreSQL refuse one of
 * them with "tuple concurrently updated", and the script ends with a raw stack trace
 * instead of its own sentence. On the development laptop: 3 rounds out of 8.
 *
 * When that happens: `pnpm test:int` and `pnpm test:e2e` started in two terminals, two
 * pipeline jobs on one database server, a restore that provisions while a test tier is
 * starting. The README says the command is "safe to run again"; at the same time is again.
 */

const DATABASES = ['confera_edgea_test', 'confera_edgeb_test'] as const;
const ROUNDS = 10;

describe('edge case (M1-REV-01): two db:provision at the same moment', () => {
  jest.setTimeout(300_000);

  let superuser: Client;

  beforeAll(async () => {
    superuser = await connectAsSuperuser();
  });

  afterAll(async () => {
    for (const database of DATABASES) {
      await superuser.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
    await superuser.end();
  });

  it(`both succeed, ${String(ROUNDS)} rounds in a row`, async () => {
    const failures: string[] = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const results = await Promise.all(
        DATABASES.map(async (database) => ({
          database,
          result: await runNode(['scripts/db-provision.mjs', '--database', database], {
            timeoutMs: 60_000,
          }),
        })),
      );
      for (const { database, result } of results) {
        if (result.exitCode !== 0) {
          const reason = /error: [^\r\n]+/.exec(result.stderr)?.[0] ?? result.stderr.slice(0, 200);
          failures.push(
            `round ${String(round)}, ${database}: exit code ${String(result.exitCode)}, ${reason}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
