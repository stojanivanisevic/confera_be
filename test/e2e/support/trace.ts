import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * The trace of a whole end-to-end run (M2-QA-01, ST-17, NFR-PRIV-04).
 *
 * Every test file empties the database when it starts, so a scan at the end of the run
 * would see only the rows of the last file. The trace keeps what every file left:
 *
 * - every line the application under test logs (`log.jsonl`);
 * - before every reset and at the end of the run, every text, character and JSON value of
 *   every table of the schema, read as the superuser (row-level security would hide the
 *   rows of the organisations), and every SHA-256 the tables keep of a token
 *   (`db-<n>.json`).
 *
 * After the run (`global-teardown.ts`) every word of the shape of a token that appears in a
 * stored text, a job payload or the log is hashed: when the hash is one the database keeps
 * of a secure link, a session or a known device, a live token was stored or logged. The
 * log is searched for the personal data the database held (addresses, names, client
 * addresses) as well.
 */
export const TRACE_DIR = join(__dirname, '..', '..', '..', 'tmp', 'e2e-trace');

const TOKEN_WORD = /[A-Za-z0-9_-]{43}/g;

export function startTrace(): void {
  rmSync(TRACE_DIR, { recursive: true, force: true });
  mkdirSync(TRACE_DIR, { recursive: true });
}

export function traceLog(chunk: string): void {
  try {
    appendFileSync(join(TRACE_DIR, 'log.jsonl'), chunk);
  } catch {
    // No trace directory (a test file run outside `pnpm test:e2e`): nothing to keep.
  }
}

function superuserUrl(): string | null {
  const owner = process.env.CONFERA_E2E_OWNER_URL;
  const password = process.env.POSTGRES_PASSWORD;
  if (owner === undefined || password === undefined || password === '') {
    return null;
  }
  const url = new URL(owner);
  url.username = 'postgres';
  url.password = password;
  return url.toString();
}

interface Snapshot {
  /** table.column -> values */
  readonly values: Record<string, string[]>;
  /** The SHA-256 of every token the tables keep. */
  readonly hashes: string[];
}

/** Keeps every stored text value and every token hash of the database as it is now. */
export async function snapshotDatabase(label: string): Promise<void> {
  const address = superuserUrl();
  if (address === null) {
    return;
  }
  const client = new Client({ connectionString: address });
  await client.connect();
  try {
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'citext', 'jsonb', 'json', 'character varying', 'character', 'USER-DEFINED')
          AND c.table_name <> '_prisma_migrations'`,
    );
    const values: Record<string, string[]> = {};
    const hashes: string[] = [];
    for (const { table_name, column_name } of columns.rows) {
      const result = await client.query<{ value: string | null }>(
        `SELECT "${column_name}"::text AS value FROM "${table_name}" WHERE "${column_name}" IS NOT NULL`,
      );
      const list = result.rows.map(({ value }) => value ?? '');
      if (column_name.endsWith('hash')) {
        hashes.push(...list.filter((value) => /^[0-9a-f]{64}$/.test(value)));
      } else {
        values[`${table_name}.${column_name}`] = list;
      }
    }
    const count = readdirSync(TRACE_DIR).filter((name) => name.startsWith('db-')).length;
    writeFileSync(
      join(TRACE_DIR, `db-${String(count).padStart(4, '0')}.json`),
      JSON.stringify({ label, values, hashes } satisfies Snapshot & { label: string }),
    );
  } finally {
    await client.end();
  }
}

export interface TraceFinding {
  readonly where: string;
  readonly what: string;
}

const digest = (word: string) => createHash('sha256').update(word, 'utf8').digest('hex');

/** Scans the trace of the run. Returns what it found; empty when nothing leaked. */
export function scanTrace(directory = TRACE_DIR): {
  findings: TraceFinding[];
  scanned: { snapshots: number; logBytes: number; hashes: number };
} {
  const files = readdirSync(directory).filter((name) => name.startsWith('db-'));
  const snapshots = files.map(
    (name) =>
      JSON.parse(readFileSync(join(directory, name), 'utf8')) as Snapshot & { label: string },
  );
  let log: string;
  try {
    log = readFileSync(join(directory, 'log.jsonl'), 'utf8');
  } catch {
    log = '';
  }
  const hashes = new Set(snapshots.flatMap((snapshot) => snapshot.hashes));
  const findings: TraceFinding[] = [];

  const searchTokens = (where: string, text: string) => {
    for (const word of text.match(TOKEN_WORD) ?? []) {
      if (hashes.has(digest(word))) {
        findings.push({ where, what: `a live token (${word.slice(0, 6)}...)` });
      }
    }
  };
  for (const snapshot of snapshots) {
    for (const [column, list] of Object.entries(snapshot.values)) {
      for (const value of list) {
        searchTokens(`${snapshot.label}: ${column}`, value);
      }
    }
  }
  searchTokens('the application log', log);

  // Personal data in the log: every address and name the database held.
  const personal = new Set<string>();
  for (const snapshot of snapshots) {
    for (const [column, list] of Object.entries(snapshot.values)) {
      if (
        /\.(email|display_name|recipient|recipient_address|new_email|username|from_address|client_address)$/.test(
          column,
        )
      ) {
        for (const value of list) {
          if (value.length >= 5 && value !== '127.0.0.1' && value !== '::1') {
            personal.add(value);
          }
        }
      }
    }
  }
  for (const value of personal) {
    if (log.includes(value)) {
      findings.push({ where: 'the application log', what: `personal data (${value})` });
    }
  }
  // The audit log keeps no personal values either (FR-AUD-03 as amended by SA-18). The
  // sender name of a mail server is on the list of audit-fields.ts on purpose: a value that
  // is also a sender name is not counted.
  const senderNames = new Set(
    snapshots.flatMap((snapshot) => snapshot.values['mail_servers.from_name'] ?? []),
  );
  for (const snapshot of snapshots) {
    for (const [column, list] of Object.entries(snapshot.values)) {
      if (!column.startsWith('audit_entries.')) {
        continue;
      }
      for (const value of list) {
        for (const item of personal) {
          if (!senderNames.has(item) && value.includes(item)) {
            findings.push({
              where: `${snapshot.label}: ${column}`,
              what: `personal data (${item})`,
            });
          }
        }
      }
    }
  }
  for (const address of log.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? []) {
    findings.push({ where: 'the application log', what: `an email address (${address})` });
  }
  return {
    findings,
    scanned: { snapshots: snapshots.length, logBytes: log.length, hashes: hashes.size },
  };
}
