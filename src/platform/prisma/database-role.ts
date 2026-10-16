import type { PrismaClient } from '../../generated/prisma/client';

/**
 * What a database connection is allowed to do, as the database itself reports it.
 * Read at every start (ADR-05): row-level security is switched off in silence for a
 * superuser, for a role with BYPASSRLS and (without FORCE) for a table owner, and a
 * restore or a mistake can turn the application role into one of them.
 */
export interface DatabaseRole {
  readonly name: string;
  /** The time zone of the session; it must be UTC (see SESSION_OPTIONS in tenant-client.ts). */
  readonly timeZone: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly createDb: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  /** May create a schema in this database. */
  readonly createSchema: boolean;
  /** May create temporary tables in this database. */
  readonly createTemp: boolean;
  /** May create a table or any other object in the schema `public`. */
  readonly createInSchema: boolean;
  /** Is, or is a member of, the role that owns the database, the schema or one of its tables. */
  readonly owner: boolean;
  /**
   * Roles this role is a member of, through any chain of memberships, that are a
   * superuser; that may bypass row-level security (the system role among them); or that
   * may create roles or databases, or replicate. A member may become such a role with one
   * statement, SET ROLE, or holds its rights already by inheritance.
   */
  readonly memberOfSuperuser: readonly string[];
  readonly memberOfBypassRls: readonly string[];
  readonly memberOfCreateRole: readonly string[];
  /**
   * Predefined roles of PostgreSQL (`pg_...`) this role is a member of, through any chain
   * of memberships, apart from `pg_database_owner` (that one is ownership, refused above).
   */
  readonly memberOfPredefined: readonly string[];
}

/**
 * The predefined roles of PostgreSQL 18, each refused for the application role and the
 * system role, by what it would let a compromised application do beyond the rows its
 * grants and the row-level security give it. `pg_database_owner` is not listed: it is
 * the owner of the database, which the ownership rule refuses. A predefined role that a
 * later version adds is refused too, until it is decided here (fail closed); a test
 * compares this list with the roles of the server.
 */
export const REFUSED_PREDEFINED_ROLES: Readonly<Record<string, string>> = {
  pg_read_server_files: 'reads any file the server can read, the data files included',
  pg_write_server_files: 'writes any file the server can write',
  pg_execute_server_program: 'runs any program as the operating-system user of the server',
  pg_read_all_data: 'reads every table and column, past the grants that keep it from them',
  pg_write_all_data: 'writes every table, past the grants',
  pg_read_all_settings: 'reads the settings only a superuser sees (file paths, archive_command)',
  pg_read_all_stats: 'reads the statements of every other session',
  pg_stat_scan_tables: 'runs functions that lock and scan any table',
  pg_monitor: 'holds the three roles before it',
  pg_signal_backend: 'cancels or ends the sessions of the other roles',
  pg_signal_autovacuum_worker: 'ends the workers that clean up the tables',
  pg_checkpoint: 'forces checkpoints, a load on the whole server',
  pg_maintain: 'runs VACUUM, CLUSTER, REINDEX and LOCK TABLE on any table',
  pg_use_reserved_connections: 'takes the connections reserved for administrators',
  pg_create_subscription: 'subscribes to other servers, with connections out of this one',
};

export async function describeRole(client: PrismaClient): Promise<DatabaseRole> {
  const rows = await client.$queryRaw<DatabaseRole[]>`
    SELECT
      current_user::text AS "name",
      current_setting('TimeZone') AS "timeZone",
      r.rolsuper AS "superuser",
      r.rolbypassrls AS "bypassRls",
      r.rolcreatedb AS "createDb",
      r.rolcreaterole AS "createRole",
      r.rolreplication AS "replication",
      has_database_privilege(current_user, current_database(), 'CREATE') AS "createSchema",
      has_database_privilege(current_user, current_database(), 'TEMPORARY') AS "createTemp",
      has_schema_privilege(current_user, 'public', 'CREATE') AS "createInSchema",
      (
        EXISTS (
          SELECT 1 FROM pg_database d
          WHERE d.datname = current_database() AND pg_has_role(current_user, d.datdba, 'MEMBER')
        )
        OR EXISTS (
          SELECT 1 FROM pg_namespace n
          WHERE n.nspname = 'public' AND pg_has_role(current_user, n.nspowner, 'MEMBER')
        )
        OR EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND pg_has_role(current_user, c.relowner, 'MEMBER')
        )
      ) AS "owner",
      ARRAY(
        SELECT x.rolname::text FROM pg_roles x
        WHERE x.oid <> r.oid AND x.rolsuper AND pg_has_role(current_user, x.oid, 'MEMBER')
        ORDER BY 1
      ) AS "memberOfSuperuser",
      ARRAY(
        SELECT x.rolname::text FROM pg_roles x
        WHERE x.oid <> r.oid AND x.rolbypassrls AND pg_has_role(current_user, x.oid, 'MEMBER')
        ORDER BY 1
      ) AS "memberOfBypassRls",
      ARRAY(
        SELECT x.rolname::text FROM pg_roles x
        WHERE x.oid <> r.oid
          AND (x.rolcreaterole OR x.rolcreatedb OR x.rolreplication)
          AND pg_has_role(current_user, x.oid, 'MEMBER')
        ORDER BY 1
      ) AS "memberOfCreateRole",
      ARRAY(
        SELECT x.rolname::text FROM pg_roles x
        WHERE x.oid <> r.oid
          AND left(x.rolname, 3) = 'pg_'
          AND x.rolname <> 'pg_database_owner'
          AND pg_has_role(current_user, x.oid, 'MEMBER')
        ORDER BY 1
      ) AS "memberOfPredefined"
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;
  const role = rows[0];
  if (role === undefined) {
    throw new Error('The database did not describe the current role.');
  }
  return role;
}

export type RoleKind = 'application' | 'system';

/**
 * Why a role must not run the API. An empty list means it may.
 * The system role may bypass the policies (that is its purpose); nothing else differs.
 */
export function roleProblems(kind: RoleKind, role: DatabaseRole): string[] {
  const problems: string[] = [];
  if (role.superuser) {
    problems.push('is a superuser');
  }
  if (role.memberOfSuperuser.length > 0) {
    problems.push(
      `is a member of a superuser role (${role.memberOfSuperuser.join(', ')}) and may become it with SET ROLE`,
    );
  }
  if (role.bypassRls && kind === 'application') {
    problems.push('may bypass row-level security (BYPASSRLS)');
  }
  if (role.memberOfBypassRls.length > 0 && kind === 'application') {
    problems.push(
      `is a member of a role that may bypass row-level security (${role.memberOfBypassRls.join(', ')}) and may become it with SET ROLE`,
    );
  }
  if (role.memberOfCreateRole.length > 0) {
    problems.push(
      `is a member of a role that may create roles or databases, or replicate (${role.memberOfCreateRole.join(', ')})`,
    );
  }
  if (role.memberOfPredefined.length > 0) {
    const reasons = role.memberOfPredefined.map(
      (name) =>
        `${name}: ${REFUSED_PREDEFINED_ROLES[name] ?? 'a predefined role this check does not know yet'}`,
    );
    problems.push(`is a member of predefined roles of PostgreSQL (${reasons.join('; ')})`);
  }
  if (role.owner) {
    problems.push('owns the database, the schema or a table, or is a member of the role that does');
  }
  if (role.createSchema || role.createInSchema) {
    problems.push('may create tables or schemas');
  }
  if (role.createTemp) {
    problems.push('may create temporary tables');
  }
  if (role.createDb || role.createRole || role.replication) {
    problems.push('may create databases or roles, or replicate');
  }
  if (role.timeZone !== 'UTC') {
    // Not a right of the role, but of its sessions: every expiry would move by the offset.
    problems.push('runs its sessions in a time zone other than UTC');
  }
  return problems;
}
