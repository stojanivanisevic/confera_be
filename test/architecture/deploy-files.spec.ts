import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEV_PREFIX, DEV_VARIABLE_NAMES, STAGES } from '../../src/config/config.schema';
import { TOOL_ONLY_VARIABLES } from '../../src/config/stage-guard';
import { repoRoot } from '../support/run-node';

/**
 * ST-04 (govcore matrix, row 3): "the master password in the non-dev compose file and
 * the environment example". No compose file, no Dockerfile and no file under deploy/
 * holds a `DEV_*` key; and a file that describes a SERVER holds no development stage,
 * no credential of the migration job and no placeholder password of the local stack.
 *
 * In 0.1.0 the files of a server are deploy/api.env.example alone (it has its own test,
 * production-env-template.spec.ts). The production compose file and the Dockerfile
 * arrive with M4-BE-07: this test finds them by their place and name, so they are under
 * these rules from their first commit, without anybody adding them to a list.
 */

interface ScannedFile {
  readonly name: string;
  readonly text: string;
}

const COMPOSE = /^(docker-)?compose[^/]*\.ya?ml$/;
const DOCKERFILE = /^Dockerfile[^/]*$|\.dockerfile$/i;

/** The development stack of the developer machine. Every other compose file is a server's. */
const DEVELOPMENT_COMPOSE = 'docker-compose.yml';

function walk(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function collect(): ScannedFile[] {
  const atRoot = readdirSync(repoRoot)
    .filter((name) => COMPOSE.test(name) || DOCKERFILE.test(name) || name === '.dockerignore')
    .map((name) => join(repoRoot, name));
  return [...atRoot, ...walk(join(repoRoot, 'deploy'))]
    .map((path) => ({
      name: relative(repoRoot, path).replaceAll('\\', '/'),
      text: readFileSync(path, 'utf8'),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Every `DEV_...` name in a text: as a key, in a `${...}`, in a list, commented out or not. */
function devKeys(text: string): string[] {
  return [...new Set(text.match(new RegExp(`\\b${DEV_PREFIX}[A-Z0-9_]*`, 'g')) ?? [])];
}

/** What a file of a server must not hold, one line per finding. */
function serverFileProblems({ name, text }: ScannedFile): string[] {
  const problems: string[] = [];
  for (const key of devKeys(text)) {
    problems.push(`${name}: holds the development key ${key}`);
  }
  for (const variable of TOOL_ONLY_VARIABLES) {
    if (new RegExp(`\\b${variable}\\b`).test(text)) {
      problems.push(`${name}: holds ${variable}, a credential of the migration job`);
    }
  }
  const stages = [...text.matchAll(/\bSTAGE\s*[:=]\s*["']?([A-Za-z_-]*)/g)].map(
    (match) => match[1] ?? '',
  );
  for (const stage of stages) {
    if (stage !== 'prod' && stage !== '') {
      problems.push(`${name}: sets STAGE to "${stage}"; every server runs prod`);
    }
  }
  if (/local-only-|invented-/.test(text)) {
    problems.push(`${name}: holds a placeholder password of the development stack`);
  }
  if (/postgres(ql)?:\/\/[^\s:/]+:[^\s@]+@/.test(text)) {
    problems.push(`${name}: holds a database address with a password`);
  }
  return problems;
}

const files = collect();
const isServerFile = ({ name }: ScannedFile): boolean => name !== DEVELOPMENT_COMPOSE;

describe('compose files, Dockerfiles and deploy/ (ST-04, govcore matrix row 3)', () => {
  it('the scan sees the development stack and the environment template of a server', () => {
    expect(files.map((file) => file.name)).toEqual(
      expect.arrayContaining(['deploy/api.env.example', DEVELOPMENT_COMPOSE]),
    );
  });

  describe('the scan finds what it is there for', () => {
    it.each([
      ['a key', 'DEV_API_DOCS=true', ['DEV_API_DOCS']],
      ['a key that is commented out', '# DEV_LOG_QUERIES=true', ['DEV_LOG_QUERIES']],
      ['a compose list entry', '      - DEV_LOGIN=${DEV_LOGIN}', ['DEV_LOGIN']],
      ['a compose mapping', '      DEV_MASTER_PASSWORD: "x"', ['DEV_MASTER_PASSWORD']],
      ['a pass-through', '      - DEV_ANYTHING', ['DEV_ANYTHING']],
      ['a Dockerfile line', 'ENV DEV_API_DOCS=true', ['DEV_API_DOCS']],
      ['a build argument', 'ARG DEV_TOOLS', ['DEV_TOOLS']],
    ])('%s', (_name, text, expected) => {
      expect(devKeys(text)).toEqual(expected);
      expect(serverFileProblems({ name: 'compose.yml', text }).length).toBeGreaterThan(0);
    });

    it.each([
      ['a development stage', 'STAGE=local'],
      ['a development stage in a compose mapping', '      STAGE: "dev"'],
      ['the owner address', 'MIGRATION_DATABASE_URL='],
      ['the superuser password', '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}'],
      ['a placeholder password of the local stack', 'DATABASE_URL=x:local-only-app@db'],
      [
        'a database address with a password',
        ['DATABASE_URL=postgresql://confera_app', 'Sup3rSecret@db:5432/confera'].join(':'),
      ],
    ])('in a file of a server: %s', (_name, text) => {
      expect(serverFileProblems({ name: 'compose.yml', text })).toHaveLength(1);
    });

    it('and accepts what a file of a server looks like', () => {
      const text = ['STAGE=prod', 'INSTANCE=', 'DATABASE_URL=', '# LOG_LEVEL=info'].join('\n');
      expect(serverFileProblems({ name: 'deploy/api.env.example', text })).toEqual([]);
    });

    it('knows every DEV_ key and every stage of the schema', () => {
      for (const key of DEV_VARIABLE_NAMES) {
        expect(devKeys(`${key}=true`)).toEqual([key]);
      }
      for (const stage of STAGES.filter((value) => value !== 'prod')) {
        expect(serverFileProblems({ name: 'x.env', text: `STAGE=${stage}` })).toHaveLength(1);
      }
    });
  });

  it.each(files.map((file) => [file.name, file] as const))(
    '%s holds no DEV_ key, not even commented out',
    (_name, file) => {
      expect(devKeys(file.text)).toEqual([]);
    },
  );

  it.each(files.filter(isServerFile).map((file) => [file.name, file] as const))(
    '%s, a file of a server, holds nothing of a developer machine',
    (_name, file) => {
      expect(serverFileProblems(file)).toEqual([]);
    },
  );

  describe(`${DEVELOPMENT_COMPOSE}, the development stack`, () => {
    const compose = files.find((file) => file.name === DEVELOPMENT_COMPOSE)?.text ?? '';

    it('says that it is for the developer machine only', () => {
      expect(compose).toMatch(/For the developer machine only/);
    });

    it('publishes every port on the loopback address only', () => {
      // The host port is this checkout's own, a variable the stack script sets (M1-ISS-13);
      // the address in front of it is always the loopback address.
      const published = [...compose.matchAll(/^\s*-\s*'([^']+:\d+)'/gm)].map((match) => match[1]);
      expect(published.length).toBeGreaterThanOrEqual(3);
      for (const entry of published) {
        expect(entry).toMatch(/^127\.0\.0\.1:\$\{CONFERA_[A-Z_]+_PORT:\?[^}]+\}:\d+$/);
      }
    });

    it('holds no value of a password: it comes from .env', () => {
      expect(compose).not.toMatch(/local-only-|invented-/);
      expect(compose).toContain('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?');
    });

    it('does not start the API, so it hands no stage and no convenience to it', () => {
      expect(compose).not.toMatch(/\bSTAGE\b/);
      expect(compose).not.toMatch(/\bINSTANCE\b/);
    });
  });
});
