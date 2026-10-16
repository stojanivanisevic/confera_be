import { loadDotEnv } from '../../support/prepare-database';
import { scanTrace, snapshotDatabase } from './trace';

/**
 * Runs once after the end-to-end tests (M2-QA-01; ST-17, NFR-PRIV-04): keeps what the last
 * test file left in the database, then scans the trace of the whole run. A live token of a
 * secure link, a session or a known device in any stored text, job payload or log line,
 * or personal data in the log, fails the run.
 */
export default async function globalTeardown(): Promise<void> {
  loadDotEnv();
  await snapshotDatabase('after the run');
  const { findings, scanned } = scanTrace();
  if (scanned.snapshots === 0) {
    throw new Error(
      'The trace of the run holds no snapshot of the database: the scan saw nothing.',
    );
  }
  if (findings.length > 0) {
    const unique = [...new Set(findings.map(({ where, what }) => `${where}: ${what}`))];
    throw new Error(
      `The scan after the run found ${String(unique.length)} leak(s) (ST-17, NFR-PRIV-04):\n${unique.slice(0, 40).join('\n')}`,
    );
  }
  process.stdout.write(
    `\nScan after the run (ST-17, NFR-PRIV-04): ${String(scanned.snapshots)} snapshots, ${String(scanned.hashes)} token hashes, ${String(scanned.logBytes)} bytes of log; nothing leaked.\n`,
  );
}
