import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';

/**
 * The scan for literal values bound to secret-like names (scripts/secret-assignments/,
 * README section 12; defect D2 of the 0.1.0 verification).
 *
 * The rule is set by the lead and written at the top of the scanner. What holds it in
 * place are its two corpora, which lie beside it and are run here:
 *
 * - shapes that must be reported: every syntax in which a name gets a value;
 * - ordinary lines that must not be: labels, messages, policies, types, references,
 *   placeholders.
 *
 * The scanner and the corpora are copied unchanged into `confera_fe`, so they are run as
 * the program they are (`--self-test`), not imported.
 */

const SCANNER = join('scripts', 'secret-assignments', 'secret-assignments.mjs');

interface SelfTest {
  readonly ok: boolean;
  readonly reported: {
    readonly total: number;
    readonly syntaxes: readonly string[];
    readonly missed: readonly unknown[];
  };
  readonly ordinary: { readonly total: number; readonly wrong: readonly unknown[] };
}

/** Every way of binding a value to a name that the rule lists. */
const SYNTAXES_OF_THE_RULE = [
  'NAME=value',
  'export NAME=value',
  'NAME="value" in quotes',
  '- NAME=value after a list dash',
  'ENV and ARG of a Dockerfile',
  'name: value in YAML',
  '"name": value in JSON',
  'assignment in JavaScript',
  'declaration in JavaScript',
  'typed declaration in TypeScript',
  'object property in JavaScript',
  'default parameter in JavaScript',
  'fallback with ?? in JavaScript',
  'fallback with || in JavaScript',
  'branch of a ternary in JavaScript',
];

describe('scan for literal values bound to secret-like names', () => {
  jest.setTimeout(120_000);

  describe('the two corpora', () => {
    let result: SelfTest;

    beforeAll(async () => {
      const run = await runNode([SCANNER, '--self-test', '--json']);
      if (run.stdout.trim() === '') {
        throw new Error(`the self-test printed nothing:\n${run.output}`);
      }
      result = JSON.parse(run.stdout) as SelfTest;
    });

    it('every shape that must be reported is reported, by its name and nothing else', () => {
      expect(result.reported.missed).toEqual([]);
    });

    it('no ordinary line is reported', () => {
      expect(result.ordinary.wrong).toEqual([]);
    });

    it('the corpus of shapes covers every syntax of the rule', () => {
      for (const syntax of SYNTAXES_OF_THE_RULE) {
        expect(result.reported.syntaxes).toContain(syntax);
      }
      // The planted cases of `pnpm test:supply-chain` that are bindings, and more.
      expect(result.reported.total).toBeGreaterThanOrEqual(40);
    });

    it('the corpus of ordinary lines holds at least twenty files of them', () => {
      expect(result.ordinary.total).toBeGreaterThanOrEqual(20);
    });

    it('the program says so with its exit code', async () => {
      const run = await runNode([SCANNER, '--self-test']);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toMatch(
        /shapes that must be reported: (\d+) of \1; ordinary lines left alone: (\d+) of \2/,
      );
    });
  });

  describe('which names are secret-like', () => {
    const SECRET_LIKE = [
      'password',
      'Password',
      'smtpPassword',
      'SMTP_PASSWORD',
      'smtp-password',
      'spring.datasource.password',
      'MYSQL_PASSWD',
      'secret',
      'clientSecret',
      'SESSION_SECRET',
      'token',
      'accessToken',
      'csrf-token',
      'apiKey',
      'API_KEY',
      'apikey',
      'x-api-key',
      'APIKey',
      'privateKey',
      'credential',
      'AWS_CREDENTIALS',
      'DATA_KEY',
      'api key',
      'API_KEY_2',
      'password2',
    ];
    const ORDINARY = [
      'passwordPolicy',
      'tokenType',
      'secretName',
      'PASSWORD_MIN_LENGTH',
      'passwordHash',
      'passwordLabel',
      'tokens',
      'secrets',
      'passwords',
      'key',
      'publicKey',
      'primaryKey',
      'cacheKey',
      'tokenizer',
      'secretary',
      'TOKEN_TTL_SECONDS',
      'SESSION_SECRET_FILE',
      'credentialsPath',
      'apiKeyHeader',
      'monkey',
      '',
    ];

    let verdicts: Record<string, boolean>;

    beforeAll(async () => {
      const program = `
        import { isSecretLikeName } from './scripts/secret-assignments/secret-assignments.mjs';
        const names = JSON.parse(process.argv[1]);
        process.stdout.write(JSON.stringify(Object.fromEntries(names.map((n) => [n, isSecretLikeName(n)]))));
      `;
      const run = await runNode([
        '--input-type=module',
        '--eval',
        program,
        JSON.stringify([...SECRET_LIKE, ...ORDINARY]),
      ]);
      if (run.exitCode !== 0) {
        throw new Error(run.output);
      }
      verdicts = JSON.parse(run.stdout) as Record<string, boolean>;
    });

    it.each(SECRET_LIKE)('"%s" is, or ends with, a secret word', (name) => {
      expect(verdicts[name]).toBe(true);
    });

    it.each(ORDINARY)('"%s" is not: it only contains one, or none', (name) => {
      expect(verdicts[name]).toBe(false);
    });
  });

  describe('a directory', () => {
    // Under tmp/ of the repository (ignored by git), not under the temporary folder of
    // the system, where an antivirus may take files away.
    const root = join(repoRoot, 'tmp');
    let directory: string;

    async function scan(files: Record<string, string>, ...args: string[]) {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), text);
      }
      const run = await runNode([SCANNER, directory, ...args]);
      const findings = [
        ...run.stdout.matchAll(/^(.+)\n {2}(\d+) {2}error .*bound to "([^"]+)"/gm),
      ].map(
        ([, file = '', line = '', name = '']) =>
          `${file.replaceAll('\\', '/').slice(directory.replaceAll('\\', '/').length + 1)}:${line} ${name}`,
      );
      return { exitCode: run.exitCode, output: run.output, findings };
    }

    beforeEach(() => {
      mkdirSync(root, { recursive: true });
      directory = mkdtempSync(join(root, 'secret-scan-'));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('names the file, the line and the name, never the value, and fails', async () => {
      const value = 'Zk3vN8qLm2Xw5Rt9Yb4Hc7Dg';
      const { exitCode, output, findings } = await scan({
        'deploy/server.env': `STAGE=prod\nSMTP_PASSWORD=${value}\n`,
        'src/session.ts': `export const sessionSecret: string = '${value}';\n`,
        'config/app.yml': `smtp:\n  host: mail.example.test\n  password: ${value}\n`,
      });
      expect(exitCode).toBe(1);
      expect(findings.sort()).toEqual([
        'config/app.yml:3 password',
        'deploy/server.env:2 SMTP_PASSWORD',
        'src/session.ts:1 sessionSecret',
      ]);
      expect(output).not.toContain(value);
      expect(output).toContain('3 literal value(s) bound to a name like a secret.');
      expect(output).toContain('invented- or local-only-');
    });

    it('passes, and prints nothing, when every value follows the rule', async () => {
      const { exitCode, output } = await scan({
        '.env.example': 'SMTP_PASSWORD=invented-mail-password\nAPI_TOKEN=\nDATA_KEY=${DATA_KEY}\n',
        'src/config.ts': 'export const password = process.env.SMTP_PASSWORD;\n',
        'compose.yaml':
          'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: local-only-owner\n',
      });
      expect({ exitCode, output }).toEqual({ exitCode: 0, output: '' });
    });

    it('reads what git tracks or would take: an ignored file is not read', async () => {
      const { findings } = await scan({
        '.gitignore': '.env\nnode_modules/\n',
        '.env': 'SMTP_PASSWORD=hunter2\n',
        'node_modules/x/index.js': "exports.token = 'hunter2';\n",
        'kept.env': 'SMTP_PASSWORD=hunter2\n',
      });
      expect(findings).toEqual(['kept.env:1 SMTP_PASSWORD']);
    });

    it('never reads a lockfile, and leaves out what the caller excludes', async () => {
      const files = {
        'pnpm-lock.yaml': 'packages:\n  token: hunter2\n',
        'package-lock.json': '{ "token": "hunter2" }\n',
        'openapi/openapi.json': '{ "example": { "password": "hunter2" } }\n',
        'vendor/lib/config.js': "module.exports = { apiKey: 'hunter2' };\n",
        'src/config.js': "module.exports = { apiKey: 'hunter2' };\n",
      };
      expect((await scan(files)).findings.sort()).toEqual([
        'openapi/openapi.json:1 password',
        'src/config.js:1 apiKey',
        'vendor/lib/config.js:1 apiKey',
      ]);
      expect(
        (await scan(files, '--exclude', 'openapi/', '--exclude', 'vendor/**/*.js')).findings,
      ).toEqual(['src/config.js:1 apiKey']);
    });

    it('steps over a file that is not a text', async () => {
      const { exitCode } = await scan({
        'image.bin': `\u0000\u0001\u0002SMTP_PASSWORD=hunter2\n`,
      });
      expect(exitCode).toBe(0);
    });
  });
});
