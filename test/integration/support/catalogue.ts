import type { Client } from 'pg';

/**
 * The catalogue check (ADR-05, finding SEC-A-12, test ST-07): reads PostgreSQL's own
 * catalogue and lists every way in which a table falls short of the tenancy rules.
 * A table added later without a policy is found here, whoever forgot it.
 */

/**
 * The reviewed list of tables that are not ordinary tenant tables. A new entry is a
 * decision: it needs a reason and a reviewer.
 */
export const REVIEWED_GLOBAL_TABLES: Readonly<Record<string, string>> = {
  _prisma_migrations:
    'Migration history of Prisma. Owned and used by the owner role only; no run-time role has any right on it.',
  organisations:
    'The tenant itself: it has no organisation_id, its policy compares its own id. Checked like a tenant table otherwise.',
};

/**
 * Reference tables (0.2.0): no organisation, the same for every organisation, seeded by
 * migration. Their rules: row-level security enabled and forced, a policy that lets every
 * role read, every policy that lets a role write restricted to the owner role, and the
 * run-time roles may read them and nothing else. A new entry is a decision, with a reason.
 */
export const REVIEWED_REFERENCE_TABLES: Readonly<Record<string, string>> = {
  roles:
    'The two roles of the MVP (ADR-05, FR-USR-01), seeded by migration. The same for every organisation; the run-time roles only read it.',
  role_permissions:
    'What each role may do (ADR-05, FR-USR-01), seeded by migration. The same for every organisation; the run-time roles only read it.',
};

/**
 * Instance tables (0.2.0): what happens before an organisation is known, such as a failed
 * sign-in for an unknown address (ADR-06). Their rules: row-level security enabled and
 * forced, and a policy for every command whose read and write checks admit a statement only
 * while NO organisation is set, so that code working inside an organisation can never read
 * or write them. The system role has no right on them. A new entry is a decision.
 */
export const REVIEWED_INSTANCE_TABLES: Readonly<Record<string, string>> = {
  security_events:
    'Failed sign-ins and failed password confirmations, for the brake and the summary in the audit log (ADR-03, ADR-06); kept 90 days (ADR-29).',
};

/** The one expression an instance table's policy may have, as pg_get_expr prints it. */
export const NO_ORGANISATION =
  "(NULLIF(current_setting('app.org_id'::text, true), ''::text) IS NULL)";

/** Tables on the reviewed list that still must carry row-level security, with the column their policy compares. */
const TENANT_KEY_COLUMN: Readonly<Record<string, string>> = { organisations: 'id' };

/** Tables no run-time role may touch at all. */
const OWNER_ONLY_TABLES = ['_prisma_migrations'];

/** What the system role may read (ADR-05: "grants limited to what the resolvers read"). */
export const SYSTEM_ROLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  mail_outbox: ['claimed_at', 'id', 'next_attempt_at', 'organisation_id', 'status'],
  secure_links: ['id', 'organisation_id', 'token_hash'],
  sessions: ['id', 'organisation_id', 'token_hash'],
  users: ['email', 'id', 'organisation_id'],
};

/** Security-definer functions that were reviewed. None so far. */
export const REVIEWED_SECURITY_DEFINER_FUNCTIONS: readonly string[] = [];

/** Views that do not run with the rights of the caller and were reviewed. None so far. */
export const REVIEWED_NON_INVOKER_VIEWS: readonly string[] = [];

const RUNTIME_ROLES = ['confera_app', 'confera_system'];
const COMMANDS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

interface TableRow {
  name: string;
  row_security: boolean;
  force_row_security: boolean;
  has_organisation_id: boolean;
  organisation_id_not_null: boolean;
  has_id: boolean;
}

interface PolicyRow {
  table: string;
  name: string;
  command: string;
  permissive: boolean;
  using: string | null;
  check: string | null;
  /** The roles the policy is for; empty for every role (PUBLIC). */
  roles: string[];
}

/** The problems of a reference table (REVIEWED_REFERENCE_TABLES). */
function referenceTableProblems(table: TableRow, policies: readonly PolicyRow[]): string[] {
  const problems: string[] = [];
  if (!table.row_security || !table.force_row_security) {
    problems.push(`${table.name}: row-level security is not enabled and forced`);
  }
  const own = policies.filter((policy) => policy.table === table.name && policy.permissive);
  if (!own.some((policy) => ['SELECT', 'ALL'].includes(policy.command))) {
    problems.push(`${table.name}: no policy lets the run-time roles read the reference table`);
  }
  for (const policy of own) {
    const writes = policy.command !== 'SELECT';
    if (writes && !(policy.roles.length === 1 && policy.roles[0] === 'confera_owner')) {
      problems.push(
        `${table.name}: policy ${policy.name} lets roles other than the owner write a reference table`,
      );
    }
  }
  return problems;
}

/** The problems of an instance table (REVIEWED_INSTANCE_TABLES). */
function instanceTableProblems(table: TableRow, policies: readonly PolicyRow[]): string[] {
  const problems: string[] = [];
  if (!table.row_security || !table.force_row_security) {
    problems.push(`${table.name}: row-level security is not enabled and forced`);
  }
  const own = policies.filter((policy) => policy.table === table.name);
  for (const command of COMMANDS) {
    if (!own.some((policy) => policy.permissive && ['ALL', command].includes(policy.command))) {
      problems.push(`${table.name}: no policy for ${command}`);
    }
  }
  for (const policy of own) {
    for (const [kind, expression] of [
      ['USING', policy.using],
      ['WITH CHECK', policy.check],
    ] as const) {
      const needed =
        kind === 'USING'
          ? policy.command !== 'INSERT'
          : ['INSERT', 'UPDATE', 'ALL'].includes(policy.command);
      if (needed && expression !== NO_ORGANISATION) {
        problems.push(
          `${table.name}: policy ${policy.name} ${kind} does not admit a statement only while no organisation is set`,
        );
      }
    }
  }
  return problems;
}

export async function catalogueProblems(client: Client): Promise<string[]> {
  const problems: string[] = [];

  const tables = (
    await client.query<TableRow>(`
      SELECT c.relname AS name,
             c.relrowsecurity AS row_security,
             c.relforcerowsecurity AS force_row_security,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organisation_id'
                     AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped) AS has_organisation_id,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organisation_id'
                     AND a.attnotnull AND NOT a.attisdropped) AS organisation_id_not_null,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id'
                     AND NOT a.attisdropped) AS has_id
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_'
      ORDER BY 1`)
  ).rows;

  const policies = (
    await client.query<PolicyRow>(`
      SELECT c.relname AS "table", p.polname AS name,
             CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                           WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS command,
             p.polpermissive AS permissive,
             pg_get_expr(p.polqual, p.polrelid) AS "using",
             pg_get_expr(p.polwithcheck, p.polrelid) AS "check",
             ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid = ANY (p.polroles)) AS roles
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid`)
  ).rows;

  for (const table of tables) {
    if (table.name in REVIEWED_REFERENCE_TABLES) {
      problems.push(...referenceTableProblems(table, policies));
      continue;
    }
    if (table.name in REVIEWED_INSTANCE_TABLES) {
      problems.push(...instanceTableProblems(table, policies));
      continue;
    }
    const reviewed = table.name in REVIEWED_GLOBAL_TABLES;
    const keyColumn = TENANT_KEY_COLUMN[table.name] ?? 'organisation_id';
    if (OWNER_ONLY_TABLES.includes(table.name)) {
      continue;
    }
    if (!reviewed) {
      if (!table.has_organisation_id) {
        problems.push(
          `${table.name}: no uuid column organisation_id, and not on the reviewed list of global tables`,
        );
      } else if (!table.organisation_id_not_null) {
        problems.push(`${table.name}: organisation_id may be NULL`);
      }
    }
    if (!table.row_security) {
      problems.push(`${table.name}: row-level security is not enabled`);
    }
    if (!table.force_row_security) {
      problems.push(`${table.name}: row-level security is not forced (the owner would be exempt)`);
    }

    const own = policies.filter((policy) => policy.table === table.name && policy.permissive);
    for (const command of COMMANDS) {
      const covering = own.filter(
        (policy) => policy.command === 'ALL' || policy.command === command,
      );
      if (covering.length === 0) {
        problems.push(`${table.name}: no policy for ${command}`);
        continue;
      }
      for (const policy of covering) {
        const needsUsing = command !== 'INSERT';
        const needsCheck = command === 'INSERT' || command === 'UPDATE';
        if (needsUsing && policy.using === null) {
          problems.push(
            `${table.name}: policy ${policy.name} has no read check (USING) for ${command}`,
          );
        }
        if (needsCheck && policy.check === null) {
          problems.push(
            `${table.name}: policy ${policy.name} has no write check (WITH CHECK) for ${command}`,
          );
        }
        for (const [kind, expression] of [
          ['USING', needsUsing ? policy.using : null],
          ['WITH CHECK', needsCheck ? policy.check : null],
        ] as const) {
          if (expression === null) {
            continue;
          }
          if (
            !expression.includes(keyColumn) ||
            !expression.includes("current_setting('app.org_id'::text, true)")
          ) {
            problems.push(
              `${table.name}: policy ${policy.name} ${kind} does not compare ${keyColumn} with the missing-ok setting app.org_id`,
            );
          }
          if (!expression.includes('NULLIF')) {
            problems.push(
              `${table.name}: policy ${policy.name} ${kind} does not treat an empty setting as no organisation`,
            );
          }
        }
      }
    }

    if (!reviewed && table.has_id) {
      const unique = await client.query(
        `SELECT 1 FROM pg_index i
         WHERE i.indrelid = $1::regclass AND i.indisunique
           AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)) = ARRAY['id', 'organisation_id']`,
        [`public.${table.name}`],
      );
      if (unique.rowCount === 0) {
        problems.push(
          `${table.name}: no unique key on (organisation_id, id) for composite foreign keys`,
        );
      }
    }
  }

  // Foreign keys between tenant tables are composite on the organisation.
  const foreignKeys = (
    await client.query<{
      name: string;
      from_table: string;
      to_table: string;
      from_columns: string[];
      to_columns: string[];
    }>(`
      SELECT con.conname AS name, src.relname AS from_table, dst.relname AS to_table,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS from_columns,
             (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS to_columns
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class dst ON dst.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'`)
  ).rows;
  for (const key of foreignKeys) {
    if (
      key.to_table === 'organisations' ||
      key.to_table in REVIEWED_GLOBAL_TABLES ||
      key.to_table in REVIEWED_REFERENCE_TABLES
    ) {
      continue;
    }
    if (
      !key.from_columns.includes('organisation_id') ||
      !key.to_columns.includes('organisation_id')
    ) {
      problems.push(
        `${key.from_table}: foreign key ${key.name} to ${key.to_table} is not composite on organisation_id`,
      );
    }
  }

  // Functions that run with their owner's rights, and views that do, would go around the policies.
  const definers = (
    await client.query<{ name: string }>(`
      SELECT p.oid::regprocedure::text AS name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')`)
  ).rows;
  for (const { name } of definers) {
    if (!REVIEWED_SECURITY_DEFINER_FUNCTIONS.includes(name)) {
      problems.push(`function ${name} is SECURITY DEFINER and not on the reviewed list`);
    }
  }
  const views = (
    await client.query<{ name: string; invoker: boolean }>(`
      SELECT c.relname AS name,
             COALESCE((SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker'), false) AS invoker
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v', 'm') AND n.nspname = 'public'`)
  ).rows;
  for (const view of views) {
    if (!view.invoker && !REVIEWED_NON_INVOKER_VIEWS.includes(view.name)) {
      problems.push(
        `view ${view.name} does not run with the rights of the caller (security_invoker)`,
      );
    }
  }

  // Grants of the run-time roles.
  const grants = (
    await client.query<{ grantee: string; table: string; privilege: string }>(`
      SELECT grantee, table_name AS "table", privilege_type AS privilege
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('confera_app', 'confera_system', 'PUBLIC')`)
  ).rows;
  for (const grant of grants) {
    if (grant.grantee === 'PUBLIC') {
      problems.push(`${grant.table}: ${grant.privilege} is granted to PUBLIC`);
    } else if (OWNER_ONLY_TABLES.includes(grant.table)) {
      problems.push(
        `${grant.table}: ${grant.grantee} has ${grant.privilege} on an owner-only table`,
      );
    } else if (grant.grantee === 'confera_system') {
      problems.push(
        `${grant.table}: the system role has ${grant.privilege} on the whole table; grant columns to it`,
      );
    } else if (grant.table in REVIEWED_REFERENCE_TABLES && grant.privilege !== 'SELECT') {
      problems.push(
        `${grant.table}: the application role has ${grant.privilege} on a reference table`,
      );
    } else if (['TRUNCATE', 'REFERENCES', 'TRIGGER'].includes(grant.privilege)) {
      problems.push(`${grant.table}: the application role has ${grant.privilege}`);
    }
  }
  const columnGrants = (
    await client.query<{ table: string; column: string; privilege: string }>(`
      SELECT table_name AS "table", column_name AS "column", privilege_type AS privilege
      FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND grantee = 'confera_system'`)
  ).rows;
  for (const grant of columnGrants) {
    const allowed = SYSTEM_ROLE_COLUMNS[grant.table] ?? [];
    if (grant.privilege !== 'SELECT' || !allowed.includes(grant.column)) {
      problems.push(
        `${grant.table}.${grant.column}: the system role has ${grant.privilege}, which is not on the reviewed list`,
      );
    }
  }

  // No run-time role may be a member of another role.
  const memberships = (
    await client.query<{ member: string; role: string }>(
      `SELECT m.rolname AS member, r.rolname AS role
       FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid
       WHERE m.rolname = ANY ($1)`,
      [RUNTIME_ROLES],
    )
  ).rows;
  for (const { member, role } of memberships) {
    problems.push(`${member} is a member of ${role}`);
  }

  return problems;
}
