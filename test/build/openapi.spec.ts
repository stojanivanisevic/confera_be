import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintResponseSchemas } from '../../src/modules/dev-tools/openapi/schema-lint';
import { repoRoot, runNode } from '../support/run-node';

/**
 * The OpenAPI pipeline on the built generator (ADR-19, ST-29):
 * the committed files equal what the code generates, and a difference fails the check.
 */

const GENERATOR = join('dist-dev', 'modules', 'dev-tools', 'openapi', 'generate.js');
const COMMITTED = join(repoRoot, 'openapi');

interface OpenApiDocument {
  info: { title: string; version: string };
  paths: Record<
    string,
    Record<string, { operationId?: string; responses: Record<string, unknown> }>
  >;
  components: { schemas: Record<string, { properties?: Record<string, { type?: string }> }> };
}

function read(directory: string, file: string): OpenApiDocument {
  return JSON.parse(readFileSync(join(directory, file), 'utf8')) as OpenApiDocument;
}

function check(directory?: string) {
  return runNode([GENERATOR, '--check', ...(directory === undefined ? [] : ['--dir', directory])]);
}

describe('OpenAPI pipeline', () => {
  jest.setTimeout(120_000);

  let copy: string;

  beforeEach(() => {
    copy = mkdtempSync(join(tmpdir(), 'confera-openapi-'));
    cpSync(COMMITTED, copy, { recursive: true });
  });

  afterEach(() => {
    rmSync(copy, { recursive: true, force: true });
  });

  it('the committed files are what the code generates', async () => {
    const result = await check();
    expect(result.output).toContain('OpenAPI files are current');
    expect(result.exitCode).toBe(0);
  });

  it('a changed response type without regeneration fails the check', async () => {
    const document = read(copy, 'openapi.json');
    const version = document.components.schemas.Meta?.properties?.version;
    expect(version?.type).toBe('string');
    version!.type = 'number';
    writeFileSync(join(copy, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);

    const result = await check(copy);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OpenAPI files are stale');
    expect(result.stderr).toContain('openapi.json: differs from the code at line');
    expect(result.stderr).toContain('"type": "number"');
    expect(result.stderr).toContain('pnpm openapi:generate');
  });

  it('a removed response property without regeneration fails the check', async () => {
    const document = read(copy, 'openapi.json');
    delete document.components.schemas.Meta?.properties?.name;
    writeFileSync(join(copy, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
    expect((await check(copy)).exitCode).toBe(1);
  });

  it('a missing file fails the check', async () => {
    rmSync(join(copy, 'openapi.public.json'));
    const result = await check(copy);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('openapi.public.json: the file does not exist');
  });

  it('writes the same files again, byte for byte', async () => {
    const target = mkdtempSync(join(tmpdir(), 'confera-openapi-write-'));
    try {
      const result = await runNode([GENERATOR, '--write', '--dir', target]);
      expect(result.exitCode).toBe(0);
      for (const file of ['openapi.json', 'openapi.public.json']) {
        const committed = readFileSync(join(COMMITTED, file), 'utf8').replace(/\r\n/g, '\n');
        expect(readFileSync(join(target, file), 'utf8')).toBe(committed);
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  describe('the committed documents', () => {
    const admin = read(COMMITTED, 'openapi.json');
    const publicDocument = read(COMMITTED, 'openapi.public.json');
    const version = (
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
    ).version;

    it('carry the version of the repository', () => {
      expect(admin.info.version).toBe(version);
      expect(publicDocument.info.version).toBe(version);
    });

    it('the admin document holds only /api/v1 and the public one only /public/v1', () => {
      expect(Object.keys(admin.paths).length).toBeGreaterThan(0);
      for (const path of Object.keys(admin.paths)) {
        expect(path).toMatch(/^\/api\/v1\//);
      }
      for (const path of Object.keys(publicDocument.paths)) {
        expect(path).toMatch(/^\/public\/v1\//);
      }
    });

    it('describe GET /api/v1/meta with a stable operation id and its response type', () => {
      const operation = admin.paths['/api/v1/meta']?.get;
      expect(operation?.operationId).toBe('getMeta');
      expect(JSON.stringify(operation?.responses['200'])).toContain('#/components/schemas/Meta');
      expect(Object.keys(admin.components.schemas.Meta?.properties ?? {})).toEqual([
        'name',
        'version',
      ]);
    });

    it('document the one error format on every operation', () => {
      for (const item of Object.values(admin.paths)) {
        for (const operation of Object.values(item)) {
          expect(JSON.stringify(operation.responses.default)).toContain('application/problem+json');
        }
      }
      expect(admin.components.schemas.Problem).toEqual(
        expect.objectContaining({ required: ['code', 'traceId'] }),
      );
    });

    it('hold no health, development or internal route', () => {
      const text = JSON.stringify([admin, publicDocument]);
      expect(text).not.toContain('/health');
      expect(text).not.toContain('/dev');
    });

    it('pass the schema lint: no response property is named like a secret (ST-29)', () => {
      expect(lintResponseSchemas(admin)).toEqual([]);
      expect(lintResponseSchemas(publicDocument)).toEqual([]);
    });
  });
});
