import { join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';

/**
 * ST-09 (lint part) and ST-65 (no CORS grant, no static mount, by construction):
 * the lint rules with a security purpose fire on the code they are meant to stop.
 *
 * Each sample is linted as if it were a file at the given path, with the same rule
 * objects that eslint.config.mjs applies. All samples are linted in one child process.
 */

interface LintMessage {
  readonly ruleId: string | null;
  readonly message: string;
  readonly fatal: boolean;
}

interface Sample {
  readonly group: 'environment' | 'raw-query' | 'cors' | 'static';
  readonly name: string;
  readonly filePath: string;
  readonly code: string;
  /** Text that the first message must contain, or null when the code must pass. */
  readonly refusedWith: string | null;
}

const ENV = 'Only src/config may read the environment';
const RAW = 'Unsafe raw queries are banned';
const CORS = 'never grants cross-origin access';
const STATIC = 'No static file serving';

const SERVICE = 'src/modules/sample/sample.service.ts';
const READS_ENV = 'export const stage = process.env.STAGE;';

const environmentReads: [string, string][] = [
  ['a member access', READS_ENV],
  ['a computed access', "export const stage = process['env'].STAGE;"],
  ['a copy of the whole environment', 'export const all = { ...process.env };'],
  ['destructuring', 'const { env } = process;\nexport const stage = env.STAGE;'],
  [
    'an import from node:process',
    "import { env } from 'node:process';\nexport const s = env.STAGE;",
  ],
  ['dotenv', "import dotenv from 'dotenv';\ndotenv.config();"],
  ['dotenv/config', "import 'dotenv/config';"],
  ['@nestjs/config', "import { ConfigService } from '@nestjs/config';\nexport { ConfigService };"],
];

const rawQueries: [string, string][] = [
  ['$queryRawUnsafe', 'export const run = (db: any, sql: string) => db.$queryRawUnsafe(sql);'],
  ['$executeRawUnsafe', 'export const run = (db: any, sql: string) => db.$executeRawUnsafe(sql);'],
  ['Prisma.raw', 'declare const Prisma: any;\nexport const part = (s: string) => Prisma.raw(s);'],
];

const samples: Sample[] = [
  ...environmentReads.map(([name, code]): Sample => ({
    group: 'environment',
    name: `${name} in application code`,
    filePath: SERVICE,
    code,
    refusedWith: ENV,
  })),
  ...[
    'src/common/logging/app-logger.ts',
    'src/platform/prisma/prisma.module.ts',
    'src/modules/dev-tools/dev-tools.module.ts',
    'src/main.ts',
    'src/config/config.spec.ts',
  ].map((filePath): Sample => ({
    group: 'environment',
    name: `process.env in ${filePath}`,
    filePath,
    code: READS_ENV,
    refusedWith: ENV,
  })),
  ...['src/config/env.ts', 'prisma.config.ts', 'test/support/run-node.ts'].map(
    (filePath): Sample => ({
      group: 'environment',
      name: `process.env in ${filePath}`,
      filePath,
      code: READS_ENV,
      refusedWith: null,
    }),
  ),
  ...rawQueries.flatMap(([name, code]): Sample[] =>
    [SERVICE, 'src/config/env.ts', 'test/integration/sample.spec.ts'].map((filePath) => ({
      group: 'raw-query',
      name: `${name} in ${filePath}`,
      filePath,
      code,
      refusedWith: RAW,
    })),
  ),
  {
    group: 'raw-query',
    name: 'the tagged template $queryRaw',
    filePath: SERVICE,
    code: 'export const run = (db: any, id: string) => db.$queryRaw`SELECT ${id}`;',
    refusedWith: null,
  },
  ...(
    [
      ['app.enableCors()', 'export const f = (app: any) => app.enableCors();'],
      ['the cors option', 'export const options = { cors: true };'],
      ['the cors package', "import cors from 'cors';\nexport { cors };"],
    ] as [string, string][]
  ).map(([name, code]): Sample => ({
    group: 'cors',
    name,
    filePath: 'src/bootstrap.ts',
    code,
    refusedWith: CORS,
  })),
  ...(
    [
      ['app.useStaticAssets()', "export const f = (app: any) => app.useStaticAssets('uploads');"],
      ['express.static()', "declare const express: any;\nexport const m = express.static('up');"],
      [
        '@nestjs/serve-static',
        "import { ServeStaticModule } from '@nestjs/serve-static';\nexport { ServeStaticModule };",
      ],
      ['serve-static', "import serveStatic from 'serve-static';\nexport { serveStatic };"],
    ] as [string, string][]
  ).map(([name, code]): Sample => ({
    group: 'static',
    name,
    filePath: 'src/bootstrap.ts',
    code,
    refusedWith: STATIC,
  })),
];

const ESLINT = join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');

describe('lint rules with a security purpose', () => {
  jest.setTimeout(120_000);

  let results: { filePath: string; messages: LintMessage[] }[] = [];

  beforeAll(async () => {
    const run = await runNode(['test/support/lint-samples.mjs'], {
      input: JSON.stringify(samples.map(({ code, filePath }) => ({ code, filePath }))),
    });
    if (run.exitCode !== 0) {
      throw new Error(`linting the samples failed:\n${run.output}`);
    }
    results = JSON.parse(run.stdout) as typeof results;
  });

  function check(group: Sample['group']): void {
    const cases = samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ sample }) => sample.group === group);

    it.each(cases.map(({ sample, index }) => [sample.name, sample, index] as const))(
      '%s',
      (_name, sample, index) => {
        const messages = results[index]?.messages ?? [];
        expect(messages.filter((message) => message.fatal)).toEqual([]);
        if (sample.refusedWith === null) {
          expect(messages).toEqual([]);
        } else {
          expect(messages.length).toBeGreaterThan(0);
          expect(messages[0]?.message).toContain(sample.refusedWith);
          expect(messages[0]?.ruleId).toMatch(/^no-restricted-(syntax|imports)$/);
        }
      },
    );
  }

  it('lints every sample', () => {
    expect(results).toHaveLength(samples.length);
  });

  describe('only the configuration module reads the environment (ST-09)', () => {
    check('environment');
  });

  describe('unsafe raw queries are banned everywhere (ST-09)', () => {
    check('raw-query');
  });

  describe('no CORS grant (ST-65)', () => {
    check('cors');
  });

  describe('no static file serving (ST-65)', () => {
    check('static');
  });

  describe('the real configuration applies these rules', () => {
    interface PrintedConfig {
      rules: Record<string, [number, ...{ selector?: string }[]] | undefined>;
    }

    async function printedConfig(filePath: string): Promise<PrintedConfig> {
      const result = await runNode([ESLINT, '--print-config', filePath]);
      return JSON.parse(result.stdout) as PrintedConfig;
    }

    function selectors(config: PrintedConfig): string[] {
      const [, ...entries] = config.rules['no-restricted-syntax'] ?? [0];
      return entries.map((entry) => entry.selector ?? '');
    }

    it('as errors, with the environment ban, for application code', async () => {
      const config = await printedConfig('src/app.module.ts');
      expect(config.rules['no-restricted-syntax']?.[0]).toBe(2);
      expect(config.rules['no-restricted-imports']?.[0]).toBe(2);
      expect(selectors(config).some((s) => s.includes("property.name='env'"))).toBe(true);
      expect(selectors(config).some((s) => s.includes('queryRawUnsafe'))).toBe(true);
      expect(selectors(config).some((s) => s.includes('enableCors'))).toBe(true);
      expect(selectors(config).some((s) => s.includes('useStaticAssets'))).toBe(true);
    });

    it('without the environment ban, and with every other ban, for src/config', async () => {
      const config = await printedConfig('src/config/env.ts');
      expect(config.rules['no-restricted-syntax']?.[0]).toBe(2);
      expect(selectors(config).some((s) => s.includes("property.name='env'"))).toBe(false);
      expect(selectors(config).some((s) => s.includes('queryRawUnsafe'))).toBe(true);
    });
  });
});
