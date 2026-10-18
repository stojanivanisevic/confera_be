import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as resolversModule from '../../src/platform/prisma/system/resolvers';
import { repoRoot } from '../support/run-node';

/**
 * Architecture tests of data access (ADR-05, findings SEC-A-11 and SEC-A-12, test ST-09).
 * They read the source files, so they need no database and run in `pnpm check`.
 */

const SRC = join(repoRoot, 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === 'generated' ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

interface Import {
  readonly file: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

const IMPORT =
  /^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

const files = sourceFiles(SRC);
const imports: Import[] = files.flatMap((path) => {
  const file = relative(repoRoot, path).replaceAll('\\', '/');
  const text = readFileSync(path, 'utf8');
  return [...text.matchAll(IMPORT)].map((match) => ({
    file,
    specifier: match[3] ?? match[4] ?? match[5] ?? match[6] ?? '',
    typeOnly: match[2] !== undefined,
  }));
});

function importers(matches: (specifier: string) => boolean, options = { includeTypeOnly: true }) {
  return [
    ...new Set(
      imports
        .filter((entry) => matches(entry.specifier) && (options.includeTypeOnly || !entry.typeOnly))
        .map((entry) => entry.file),
    ),
  ].sort();
}

describe('data access architecture', () => {
  it('reads the source tree', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(imports.length).toBeGreaterThan(50);
  });

  describe('the system client (ST-09)', () => {
    it('is imported only by the resolver module', () => {
      expect(importers((specifier) => /(^|\/)system-client$/.test(specifier))).toEqual([
        'src/platform/prisma/system/resolvers.ts',
      ]);
    });

    it('lives in a folder that holds the client and the resolvers, nothing else', () => {
      expect(readdirSync(join(SRC, 'platform', 'prisma', 'system')).sort()).toEqual([
        'resolvers.ts',
        'system-client.ts',
      ]);
    });

    it('the resolver module exports the resolvers class only', () => {
      expect(Object.keys(resolversModule)).toEqual(['SystemResolvers']);
    });

    it('the class offers only the resolvers of ADR-05 that exist so far', () => {
      /** The resolvers named by ADR-05. A name is added here in the change that adds the resolver. */
      const RESOLVERS = [
        'userByEmail',
        'sessionByTokenHash',
        'linkByTokenHash',
        'organisationsWithUsers',
        'outboxDue',
        'formByPublicKey',
      ];
      /** Not resolvers: the start-up self-description and Nest's shutdown hook. They return no tenant data. */
      const INFRASTRUCTURE = ['constructor', 'describeRole', 'onModuleDestroy'];
      const members = Object.getOwnPropertyNames(resolversModule.SystemResolvers.prototype).sort();
      expect(members).toEqual([...RESOLVERS, ...INFRASTRUCTURE].sort());
      // The client itself is a private field: an instance shows no property that holds it.
      expect(Object.keys(resolversModule.SystemResolvers.prototype)).toEqual([]);
    });

    it('is used through SystemResolvers by the start-up check, sign-in, sessions, secure links, the mail worker, the public forms, the files worker and the maintenance worker, and by nothing else', () => {
      // Every new user of the resolvers shows up here, in a diff a reviewer sees.
      expect(importers((specifier) => /(^|\/)system\/resolvers$/.test(specifier))).toEqual([
        'src/modules/access/account.service.ts',
        'src/modules/access/session.service.ts',
        'src/modules/access/sign-in.service.ts',
        'src/modules/audit/security-summary.ts',
        'src/modules/files/files-worker.ts',
        'src/modules/forms/intake.service.ts',
        'src/modules/jobs/maintenance-worker.ts',
        'src/modules/links/secure-links.ts',
        'src/modules/mail/mail-worker.ts',
        'src/platform/prisma/database-role-check.ts',
        'src/platform/prisma/prisma.module.ts',
      ]);
    });
  });

  describe('database clients', () => {
    const INSIDE = /^src\/platform\/prisma\//;

    it.each([
      ['the PostgreSQL driver', (s: string) => s === 'pg' || s.startsWith('pg/')],
      ['the Prisma driver adapter', (s: string) => s === '@prisma/adapter-pg'],
      ['the Prisma runtime', (s: string) => s.startsWith('@prisma/client')],
    ])('%s is imported only inside src/platform/prisma', (_name, matches) => {
      for (const file of importers(matches)) {
        expect(file).toMatch(INSIDE);
      }
    });

    it('the generated client is imported as a value only inside src/platform/prisma', () => {
      const users = importers((s) => s.includes('generated/prisma/'), { includeTypeOnly: false });
      for (const file of users) {
        expect(file).toMatch(INSIDE);
      }
      // Types of the generated client may be used anywhere.
      expect(users).toEqual(['src/platform/prisma/tenant-client.ts']);
    });

    it('a client is constructed in one place', () => {
      const constructing = files
        .filter((path) => /new\s+PrismaClient\s*\(/.test(readFileSync(path, 'utf8')))
        .map((path) => relative(repoRoot, path).replaceAll('\\', '/'));
      expect(constructing).toEqual(['src/platform/prisma/tenant-client.ts']);
    });

    it('the plain client factory is used only by the tenant database and the system client', () => {
      const users = files
        .filter((path) => /\bcreateBaseClient\s*\(/.test(readFileSync(path, 'utf8')))
        .map((path) => relative(repoRoot, path).replaceAll('\\', '/'))
        .sort();
      expect(users).toEqual([
        'src/platform/prisma/system/system-client.ts',
        'src/platform/prisma/tenant-client.ts',
        'src/platform/prisma/tenant-database.ts',
      ]);
    });
  });

  describe('dev tools (ST-02)', () => {
    it('nothing outside the dev-tools folder imports from it', () => {
      const outside = imports.filter(
        (entry) =>
          /(^|\/)dev-tools(\/|$)/.test(entry.specifier) &&
          !entry.file.startsWith('src/modules/dev-tools/'),
      );
      expect(outside).toEqual([]);
    });
  });
});
