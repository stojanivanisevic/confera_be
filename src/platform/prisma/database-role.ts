import type { PrismaClient } from '../../generated/prisma/client';

/**
 * What a database connection is allowed to do, as the database itself reports it.
 * Read at every start (ADR-05): row-level security is switched off in silence for a
 * superuser, for a role with BYPASSRLS and (without FORCE) for a table owner, and a
 * restore or a mistake can turn the application role into one of them.
 */
export interface DatabaseRole {
  readonly name: string;
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
}

export async function describeRole(client: PrismaClient): Promise<DatabaseRole> {
  const rows = await client.$queryRaw<DatabaseRole[]>`
    SELECT
      current_user::text AS "name",
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
      ) AS "owner"
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
  if (role.bypassRls && kind === 'application') {
    problems.push('may bypass row-level security (BYPASSRLS)');
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
  return problems;
}
