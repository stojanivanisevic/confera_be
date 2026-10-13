import { type DatabaseRole, roleProblems } from './database-role';

/** ST-08: which database roles the start-up check refuses. The check against a real database is an integration test. */

const SAFE: DatabaseRole = {
  name: 'confera_app',
  superuser: false,
  bypassRls: false,
  createDb: false,
  createRole: false,
  replication: false,
  createSchema: false,
  createTemp: false,
  createInSchema: false,
  owner: false,
};

describe('roleProblems', () => {
  it('accepts a role that can do nothing but its grants', () => {
    expect(roleProblems('application', SAFE)).toEqual([]);
    expect(roleProblems('system', SAFE)).toEqual([]);
  });

  it('lets the system role bypass the policies, and only the system role', () => {
    expect(roleProblems('system', { ...SAFE, bypassRls: true })).toEqual([]);
    expect(roleProblems('application', { ...SAFE, bypassRls: true })).toEqual([
      'may bypass row-level security (BYPASSRLS)',
    ]);
  });

  it.each<[keyof DatabaseRole, string]>([
    ['superuser', 'is a superuser'],
    ['owner', 'owns the database, the schema or a table, or is a member of the role that does'],
    ['createSchema', 'may create tables or schemas'],
    ['createInSchema', 'may create tables or schemas'],
    ['createTemp', 'may create temporary tables'],
    ['createDb', 'may create databases or roles, or replicate'],
    ['createRole', 'may create databases or roles, or replicate'],
    ['replication', 'may create databases or roles, or replicate'],
  ])('refuses both kinds of role when %s is true', (attribute, problem) => {
    for (const kind of ['application', 'system'] as const) {
      expect(roleProblems(kind, { ...SAFE, [attribute]: true })).toEqual([problem]);
    }
  });

  it('names every problem of a role that has several', () => {
    const problems = roleProblems('application', {
      ...SAFE,
      superuser: true,
      bypassRls: true,
      owner: true,
      createInSchema: true,
      createTemp: true,
    });
    expect(problems).toHaveLength(5);
  });
});
