import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';

/**
 * One development stack per checkout (M1-ISS-13; README, section 2).
 *
 * On 2026-10-14 the test suite of one checkout lost its database while it ran: another
 * checkout, which used the same Compose project, the same volume and the same port,
 * removed the volume. Since then every checkout has a stack of its own, and every command
 * that uses the database refuses one that belongs to another checkout.
 *
 * These tests need no Docker: they hold the rules of scripts/lib/stack.mjs and the files
 * that apply them. test/integration/stack-per-checkout.spec.ts plays the refusals against
 * a real container of "another checkout".
 */

const LIB = './scripts/lib/stack.mjs';

/** Runs `expression` (an async function body over the module `stack`) and returns its JSON. */
async function evaluate<T>(body: string, env: Record<string, string> = {}): Promise<T> {
  const program = `
    import * as stack from '${LIB}';
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result));
  `;
  const run = await runNode(['--input-type=module', '--eval', program], { env });
  if (run.exitCode !== 0) {
    throw new Error(run.output);
  }
  return JSON.parse(run.stdout) as T;
}

describe('one development stack per checkout (M1-ISS-13)', () => {
  jest.setTimeout(60_000);

  describe('the name of the Compose project', () => {
    it('is derived from the folder of the checkout, and differs between two folders of the same name', async () => {
      const names = await evaluate<string[]>(`
        return [
          stack.stackName({}, 'D:/Code/confera_be'),
          stack.stackName({}, 'D:/Code/confera_be'),
          stack.stackName({}, 'D:/Code/_tmp/confera_be'),
          stack.stackName({}, 'D:/Code/_wt/confera_be-m2'),
        ];
      `);
      expect(names[0]).toMatch(/^confera-be-[0-9a-f]{8}$/);
      expect(names[1]).toBe(names[0]);
      expect(names[2]).toMatch(/^confera-be-[0-9a-f]{8}$/);
      expect(names[2]).not.toBe(names[0]);
      expect(names[3]).toMatch(/^confera-be-m2-[0-9a-f]{8}$/);
      // Never the shared name of 0.1.0, whose containers, volume and port every checkout used.
      expect(names).not.toContain('confera');
    });

    it('can be set in .env, and is refused when Compose could not use it', async () => {
      const verdicts = await evaluate<string[]>(`
        const verdict = (value) => {
          try { return stack.stackName({ CONFERA_STACK_NAME: value }, 'D:/x'); }
          catch (error) { return 'refused: ' + error.message; }
        };
        return ['confera-mine', 'Confera', 'a b', '../x', '-x', 'x'.repeat(70)].map(verdict);
      `);
      expect(verdicts[0]).toBe('confera-mine');
      for (const verdict of verdicts.slice(1)) {
        expect(verdict).toMatch(/^refused: CONFERA_STACK_NAME must be/);
      }
    });
  });

  describe('the ports', () => {
    it('are the port of the three database addresses and the two of the mail catcher', async () => {
      const ports = await evaluate(`
        return stack.stackPorts({
          DATABASE_URL: 'postgresql://confera_app:local-only-app@127.0.0.1:25001/confera',
          SYSTEM_DATABASE_URL: 'postgresql://confera_system:local-only-system@127.0.0.1:25001/confera',
          MIGRATION_DATABASE_URL: 'postgresql://confera_owner:local-only-owner@127.0.0.1:25001/confera',
          CONFERA_MAIL_WEB_PORT: '26001',
          CONFERA_MAIL_SMTP_PORT: '27001',
        });
      `);
      expect(ports).toEqual({ database: 25001, mailWeb: 26001, mailSmtp: 27001 });
    });

    it('are the standard ones of .env.example when nothing else is said', async () => {
      expect(await evaluate('return stack.stackPorts({});')).toEqual({
        database: 5432,
        mailWeb: 8025,
        mailSmtp: 1025,
      });
    });

    it.each([
      [
        'database addresses that name two ports',
        {
          DATABASE_URL: 'postgresql://a:local-only-a@127.0.0.1:25001/confera',
          MIGRATION_DATABASE_URL: 'postgresql://o:local-only-o@127.0.0.1:25002/confera',
        },
        /name different ports \(25001, 25002\)/,
      ],
      ['a port that is not a number', { CONFERA_MAIL_WEB_PORT: 'x' }, /CONFERA_MAIL_WEB_PORT must/],
      ['a port above 65535', { CONFERA_MAIL_SMTP_PORT: '70000' }, /CONFERA_MAIL_SMTP_PORT must/],
      [
        'one port for two services',
        { CONFERA_MAIL_WEB_PORT: '1025' },
        /need three different ports/,
      ],
    ])('refuse %s', async (_name, env, expected) => {
      const message = await evaluate<string>(`
        try { stack.stackPorts(${JSON.stringify(env)}); return 'accepted'; }
        catch (error) { return error.message; }
      `);
      expect(message).toMatch(expected);
    });

    it('stack:ports derives a set from the folder: the same folder the same set, two folders two sets', async () => {
      const sets = await evaluate<{ database: number; mailWeb: number; mailSmtp: number }[]>(`
        return [
          stack.derivedPorts('D:/Code/_wt/a'),
          stack.derivedPorts('D:/Code/_wt/a'),
          stack.derivedPorts('D:/Code/_wt/b'),
          stack.derivedPorts('D:/Code/_wt/a', 1),
        ];
      `);
      expect(sets[1]).toEqual(sets[0]);
      expect(sets[2]).not.toEqual(sets[0]);
      expect(sets[3]).not.toEqual(sets[0]);
      for (const set of sets) {
        expect(set.database).toBeGreaterThanOrEqual(25000);
        expect(set.database).toBeLessThan(26000);
        expect(set.mailWeb - set.database).toBe(1000);
        expect(set.mailSmtp - set.database).toBe(2000);
      }
    });
  });

  describe('whose database it is', () => {
    const here = 'D:/Code/_wt/here';
    const containers = [
      {
        name: 'confera-here-postgres-1',
        project: 'confera-here-1',
        workingDir: 'd:\\code\\_wt\\here\\',
        ports: [25001],
      },
      {
        name: 'confera-other-postgres-1',
        project: 'confera-other-2',
        workingDir: 'D:\\Code\\confera_be',
        ports: [5432],
      },
      { name: 'nudge-postgres', project: null, workingDir: null, ports: [5433] },
    ];

    async function verdict(port: number): Promise<string | null> {
      return evaluate<string | null>(`
        return stack.foreignOwner({
          port: ${String(port)},
          containers: ${JSON.stringify(containers)},
          root: ${JSON.stringify(here)},
          what: 'the database of DATABASE_URL',
        });
      `);
    }

    it("is this checkout's own when its own stack publishes the port (the folder compared without case and trailing separator on Windows)", async () => {
      if (process.platform === 'win32') {
        expect(await verdict(25001)).toBeNull();
      }
    });

    it('is nobody when no container publishes the port: nothing to compare', async () => {
      expect(await verdict(25999)).toBeNull();
    });

    it('is refused when the stack of another checkout publishes it, with that checkout named', async () => {
      const message = await verdict(5432);
      expect(message).toContain(
        'the database of DATABASE_URL at 127.0.0.1:5432 belongs to the stack "confera-other-2" of another checkout, D:\\Code\\confera_be',
      );
    });

    it('is refused when a container that is no Confera stack publishes it', async () => {
      expect(await verdict(5433)).toContain('is served by the container "nudge-postgres"');
    });

    it('an address that is not on this machine is not the development stack, and is not judged', async () => {
      const result = await evaluate<boolean>(`
        stack.assertOwnDatabase(['DATABASE_URL'], {
          DATABASE_URL: 'postgresql://confera_app:x@db.confera.example:5432/confera',
        });
        return true;
      `);
      expect(result).toBe(true);
    });
  });

  describe('the files that apply the rules', () => {
    const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
    const scripts = (
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    it('docker-compose.yml fixes no container name, no volume name and no host port', () => {
      expect(compose).not.toMatch(/^\s*container_name:/m);
      expect(compose).not.toMatch(/confera_pgdata/);
      expect(compose).toMatch(/^name: \$\{CONFERA_STACK_NAME:\?[^}]+\}$/m);
      // Every published port comes from a variable that the stack script sets.
      const published = [...compose.matchAll(/^\s*-\s*'(127\.0\.0\.1:[^']+)'/gm)].map((m) => m[1]);
      expect(published).toHaveLength(3);
      for (const entry of published) {
        expect(entry).toMatch(/^127\.0\.0\.1:\$\{CONFERA_[A-Z_]+_PORT:\?[^}]+\}:\d+$/);
      }
    });

    it('the stack is started and stopped through the script of this checkout', () => {
      expect(scripts['stack:up']).toBe('node scripts/stack.mjs up');
      expect(scripts['stack:down']).toBe('node scripts/stack.mjs down');
      expect(scripts['stack:wipe']).toBe('node scripts/stack.mjs wipe');
      expect(scripts['stack:ports']).toBe('node scripts/stack.mjs ports');
    });

    it.each(['db:migrate', 'db:status', 'db:diff'])(
      '%s checks the database of the owner address before Prisma runs',
      (name) => {
        expect(scripts[name]).toMatch(
          new RegExp(
            `^node scripts/stack\\.mjs check-database --tool ${name} MIGRATION_DATABASE_URL && prisma `,
          ),
        );
      },
    );

    it('start checks both addresses of the API before it runs', () => {
      expect(scripts.start).toMatch(
        /^node scripts\/stack\.mjs check-database --tool start DATABASE_URL SYSTEM_DATABASE_URL && /,
      );
    });

    it.each([
      ['scripts/db-provision.mjs', "refuseUnlessOwnDatabase('db:provision'"],
      ['scripts/seed-e2e.mjs', 'refuseUnlessOwnDatabase(TOOL'],
      ['scripts/dev.mjs', "refuseUnlessOwnDatabase('start:dev'"],
    ])('%s refuses the database of another checkout before it connects', (file, call) => {
      expect(readFileSync(join(repoRoot, file), 'utf8')).toContain(call);
    });
  });
});
