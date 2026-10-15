import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseEnvironment } from '../../src/config/config';
import {
  DEV_PREFIX,
  SECRET_VARIABLE_NAMES,
  VARIABLE_NAMES,
  VARIABLES,
} from '../../src/config/config.schema';
import { TOOL_ONLY_VARIABLES } from '../../src/config/stage-guard';
import {
  validEnvironment,
  validProductionEnvironment,
} from '../../src/config/testing/valid-environment';
import { repoRoot } from '../support/run-node';
import { ALLOWED_PROCESS_MEMBERS, credentialComparisons, environmentAccesses } from './source-scan';

/**
 * ST-09, the part that closes row 2 of the govcore matrix: "a second master-password
 * variable outside the `DEV_` prefix".
 *
 * In govcore_be a second master password lived in a variable the dev-prefix rule did not
 * see, and the code compared what a person typed with it. The `DEV_` guard of ADR-24
 * cannot stop that by itself, because such a variable need not start with `DEV_`. What
 * stops it is three facts about the code, each kept true here:
 *
 * 1. only src/config/env.ts reads the process environment, in whatever spelling;
 * 2. the configuration has no place for a password: every variable is one of a closed
 *    set of values or a reviewed secret, and a secret is unwrapped in two reviewed places;
 * 3. no comparison anywhere has a credential on one side and configuration on the other.
 *
 * The scans read the syntax tree of every source file, and each is first shown the code
 * it must find.
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

const files = sourceFiles(SRC).map((path) => ({
  name: relative(repoRoot, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));
const applicationFiles = files.filter(({ name }) => !name.endsWith('.spec.ts'));

describe('no second master password (ST-09, govcore matrix row 2)', () => {
  it('reads the source tree', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(applicationFiles.length).toBeGreaterThan(30);
  });

  describe('1. only the configuration module reads the environment', () => {
    describe('the scan finds every spelling', () => {
      it.each([
        ['a member access', 'export const s = process.env.MASTER_PASSWORD;'],
        ['a computed access', "export const s = process['env'].MASTER_PASSWORD;"],
        ['a computed access with a built name', "export const s = process['e' + 'nv'];"],
        ['an optional access', 'export const s = process?.env?.MASTER_PASSWORD;'],
        ['destructuring', 'const { env } = process;\nexport const s = env.MASTER_PASSWORD;'],
        ['destructuring with a new name', 'const { env: e } = process;\nexport const s = e.X;'],
        ['a copy of the object', 'const p = process;\nexport const s = p.env.MASTER_PASSWORD;'],
        ['the object handed to a function', "export const s = Reflect.get(process, 'env');"],
        ['a spread of the object', 'export const s = { ...process }.env;'],
        ['globalThis', 'export const s = globalThis.process.env.MASTER_PASSWORD;'],
        ['globalThis, computed', "export const s = globalThis['process'].env;"],
        ['global', 'declare const global: any;\nexport const s = global.process.env.X;'],
        ['a named import', "import { env } from 'node:process';\nexport const s = env.X;"],
        ['a renamed import', "import { env as e } from 'process';\nexport const s = e.X;"],
        ['a namespace import', "import * as p from 'node:process';\nexport const s = p.env.X;"],
        ['a default import', "import p from 'node:process';\nexport const s = p.env.X;"],
        ['require', "export const s = require('node:process').env.X;"],
        ['a dynamic import', "export const s = async () => (await import('process')).env.X;"],
        ['a re-export', "export { env } from 'node:process';"],
        ['process.binding', "export const s = (process as any).binding('x');"],
        ['process.mainModule', 'export const s = (process as any).mainModule;'],
      ])('%s', (_name, code) => {
        expect(environmentAccesses('sample.ts', code).length).toBeGreaterThan(0);
      });

      it.each([
        ['writing to stderr', "process.stderr.write('x');"],
        ['setting the exit code', 'process.exitCode = 78;'],
        ['a clock', 'export const t = process.hrtime.bigint();'],
        ['a property that is only named process', 'export const o = { process: 1 }.process;'],
        ['a word in a comment or a text', "// process.env\nexport const s = 'process.env';"],
        ['an environment of its own', 'export const f = (env: { A: string }) => env.A;'],
      ])('and leaves alone %s', (_name, code) => {
        expect(environmentAccesses('sample.ts', code)).toEqual([]);
      });

      it('allows no member through which the environment can be reached', () => {
        for (const member of ['env', 'binding', 'mainModule', 'config', 'report', 'loadEnvFile']) {
          expect(ALLOWED_PROCESS_MEMBERS).not.toContain(member);
        }
      });
    });

    it('in src, the environment is read in src/config/env.ts and nowhere else', () => {
      const readers = files
        .map(({ name, text }) => ({ name, findings: environmentAccesses(name, text) }))
        .filter(({ findings }) => findings.length > 0);
      expect(readers).toEqual([
        { name: 'src/config/env.ts', findings: ['src/config/env.ts:8: process.env'] },
      ]);
    });

    it('that one place hands the whole environment to the schema and picks nothing itself', () => {
      const text = files.find(({ name }) => name === 'src/config/env.ts')?.text ?? '';
      expect(text).toContain('return parseEnvironment(process.env);');
      expect(text.match(/process\.env/g)).toHaveLength(1);
    });
  });

  describe('2. the configuration has no place for a password', () => {
    /**
     * The reviewed list of secret variables, with what each one is. A new secret is a
     * decision: it gets a line here, in a diff a reviewer sees. None of them is, or may
     * become, something a person types to get in.
     */
    const REVIEWED_SECRETS: Readonly<Record<string, string>> = Object.fromEntries([
      ['DATABASE_URL', 'PostgreSQL address of the application role; handed to the driver'],
      ['SYSTEM_DATABASE_URL', 'PostgreSQL address of the system role; handed to the driver'],
      [
        'DATA_KEY',
        'the data key of ADR-11, 43 to 128 characters of base64url; the secret box derives the encryption key of the stored mail passwords from it, and nothing compares it with anything',
      ],
    ]);

    /** What a master password would look like: free text. No variable may accept it. */
    const PASSPHRASES = ['correct horse battery staple!', 'Sup3r $ecret', 'lozinka šđčćž 123'];

    it('every secret variable is on the reviewed list', () => {
      expect([...SECRET_VARIABLE_NAMES].sort()).toEqual(Object.keys(REVIEWED_SECRETS).sort());
    });

    // A default for a secret would be written in the schema as the argument of a call
    // (`z.string().default('...')`). The scan for secret-like names does not read the
    // arguments of a call (its rule lets "anything that is not a literal" through), so
    // the rule "a secret has no default" is held here, on the configuration itself.
    it.each(SECRET_VARIABLE_NAMES)(
      '%s has no default: without it, or with an empty one, the start is refused on every stage',
      (name) => {
        expect(VARIABLES[name].required).toBe(true);
        for (const base of [validEnvironment({ STAGE: 'local' }), validProductionEnvironment()]) {
          const without: Record<string, string | undefined> = { ...base };
          without[name] = undefined;
          for (const environment of [without, { ...base, [name]: '' }]) {
            const result = parseEnvironment(environment);
            expect({ name, accepted: result.ok }).toEqual({ name, accepted: false });
            if (!result.ok) {
              expect(result.problems.map((problem) => problem.variable)).toContain(name);
            }
          }
        }
      },
    );

    it.each(VARIABLE_NAMES)(
      '%s does not accept free text: it is one of a closed set of values, or an address',
      (name) => {
        for (const passphrase of PASSPHRASES) {
          for (const base of [validEnvironment({ STAGE: 'local' }), validProductionEnvironment()]) {
            const result = parseEnvironment({ ...base, [name]: passphrase });
            expect({ name, accepted: result.ok }).toEqual({ name, accepted: false });
          }
        }
      },
    );

    it.each(VARIABLE_NAMES)('%s is not named like a way in', (name) => {
      expect(name).not.toMatch(/PASS|PWD|MASTER|BACKDOOR|BYPASS|IMPERSONAT/);
      // A value that is free text would have to be marked as a secret, and is then reviewed above.
      expect(typeof VARIABLES[name].secret).toBe('boolean');
    });

    it('the development conveniences are a reviewed list of flags: true, false and nothing else', () => {
      const flags = VARIABLE_NAMES.filter((name) => name.startsWith(DEV_PREFIX));
      expect(flags.sort()).toEqual(['DEV_API_DOCS', 'DEV_LOG_QUERIES']);
      for (const name of flags) {
        for (const value of ['true', 'false']) {
          const result = parseEnvironment(validEnvironment({ STAGE: 'local', [name]: value }));
          expect(result.ok).toBe(true);
        }
        expect(parseEnvironment(validEnvironment({ STAGE: 'local', [name]: 'x' })).ok).toBe(false);
      }
    });

    // Written out here, not taken from the guard's own list: a name dropped from that
    // list must fail a test. The owner role exists only in the migration job (ADR-05).
    it.each(['MIGRATION_DATABASE_URL', 'PROVISION_DATABASE_URL', 'POSTGRES_PASSWORD'])(
      'a credential of the migration job in the environment of the API stops the start on prod: %s',
      (name) => {
        const result = parseEnvironment(validProductionEnvironment({ [name]: 'anything' }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.problems.map((problem) => problem.variable)).toContain(name);
        }
        expect(TOOL_ONLY_VARIABLES).toContain(name);
      },
    );

    it('a secret is unwrapped in three reviewed places: the two database drivers and the secret box', () => {
      const unwrapping = applicationFiles
        .flatMap(({ name, text }) =>
          text
            .split(/\r?\n/)
            .filter((line) => /\.reveal\s*\(/.test(line))
            .map((line) => `${name}: ${line.trim()}`),
        )
        .sort();
      expect(unwrapping).toEqual([
        "src/modules/mail/secret-box.ts: this.#key = Buffer.from(hkdfSync('sha256', config.dataKey.reveal(), '', INFO, 32));",
        'src/platform/prisma/system/resolvers.ts: this.#client = createSystemClient(config.database.systemUrl.reveal());',
        'src/platform/prisma/tenant-database.ts: this.#base = createBaseClient(config.database.applicationUrl.reveal(), { onQuery });',
      ]);
    });
  });

  describe('3. no code compares a credential with a configuration value', () => {
    describe('the scan finds the comparison', () => {
      it.each([
        ['strict equality', 'if (dto.password === this.config.masterPassword) { ok(); }'],
        ['loose equality, turned around', 'if (config.support.password == body.password) {}'],
        ['inequality', 'if (input.password !== config.adminPassword) { throw new Error(); }'],
        ['a secret unwrapped', 'const ok = given === config.database.applicationUrl.reveal();'],
        [
          'a constant-time comparison',
          'const ok = timingSafeEqual(Buffer.from(body.token), Buffer.from(config.apiToken));',
        ],
        [
          'a constant-time comparison of a secret',
          'timingSafeEqual(Buffer.from(typed), Buffer.from(config.key.reveal()));',
        ],
        ['a hash check against configuration', 'await argon2.verify(config.adminHash, password);'],
        ['bcrypt against configuration', 'bcrypt.compareSync(dto.password, config.rootHash);'],
        ['a method comparison', 'if (dto.password.localeCompare(config.master) === 0) {}'],
        ['a header against the environment', "if (req.headers['x-master-key'] === env.KEY) {}"],
        ['a token against the environment', 'if (token === process.env.SUPPORT_TOKEN) {}'],
        ['a configuration value that is the credential', 'if (typed === config.backdoor) {}'],
        ['a switch', 'switch (dto.password) { case config.masterPassword: ok(); }'],
        ['Object.is', 'const ok = Object.is(dto.secret, config.secret);'],
      ])('%s', (_name, code) => {
        expect(credentialComparisons('sample.ts', code).length).toBeGreaterThan(0);
      });

      it.each([
        ['a stage check', "if (config.stage === 'prod') {}"],
        ['a flag check', 'if (config.devTools.apiDocs === true) {}'],
        ['a host comparison', 'const ok = host === this.hosts[surface];'],
        [
          'a password against the stored hash of its user',
          'const ok = await argon2.verify(user.passwordHash, dto.password);',
        ],
        ['a token against its stored hash', 'const ok = timingSafeEqual(stored.tokenHash, given);'],
        ['an assignment', 'this.password = config.x;'],
      ])('and leaves alone %s', (_name, code) => {
        expect(credentialComparisons('sample.ts', code)).toEqual([]);
      });
    });

    it('in src, there is none', () => {
      const found = applicationFiles.flatMap(({ name, text }) => credentialComparisons(name, text));
      expect(found).toEqual([]);
    });
  });
});
