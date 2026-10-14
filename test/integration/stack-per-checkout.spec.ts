import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { freePort } from '../support/api-process';
import { repoRoot, runNode } from '../support/run-node';
import { testDatabase } from './support/database';

/**
 * One development stack per checkout (M1-ISS-13), against real containers.
 *
 * A container is started that looks, to Docker, like the stack of ANOTHER checkout: it
 * carries the two labels Compose gives every container of a project, with the folder of
 * a checkout that is not this one. Every command that uses the database must refuse it
 * before it connects. (The container is the mail catcher, not PostgreSQL: a command that
 * got past its guard would fail on the connection with another sentence, so the sentence
 * of the refusal is the proof that nothing was attempted.)
 */

/** The image of the mail catcher of docker-compose.yml: already pulled by `stack:up`. */
function mailpitImage(): string {
  const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
  const image = /^\s*image:\s*(axllent\/mailpit\S+)/m.exec(compose)?.[1];
  if (image === undefined) {
    throw new Error('docker-compose.yml names no mail catcher image');
  }
  return image;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim();
}

/** The addresses of a database at `port`, with the roles and placeholder passwords of .env.example. */
function addressesAt(port: number): Record<string, string> {
  const at = (role: string, password: string) =>
    `postgresql://${role}:${password}@127.0.0.1:${String(port)}/confera`;
  return {
    DATABASE_URL: at('confera_app', 'local-only-app'),
    SYSTEM_DATABASE_URL: at('confera_system', 'local-only-system'),
    MIGRATION_DATABASE_URL: at('confera_owner', 'local-only-owner'),
    POSTGRES_PASSWORD: 'local-only-superuser',
  };
}

const ELSEWHERE = join(repoRoot, '..', 'confera_be-another-checkout');

describe('one development stack per checkout (M1-ISS-13)', () => {
  jest.setTimeout(180_000);

  let foreignPort: number;
  let plainPort: number;
  const started: string[] = [];

  beforeAll(async () => {
    foreignPort = await freePort();
    plainPort = await freePort();
    const image = mailpitImage();
    // The stack of another checkout, as Compose labels it.
    started.push(
      docker([
        'run',
        '--detach',
        '--rm',
        '--label',
        'com.docker.compose.project=confera-another-checkout',
        '--label',
        `com.docker.compose.project.working_dir=${ELSEWHERE}`,
        '--publish',
        `127.0.0.1:${String(foreignPort)}:1025`,
        image,
      ]),
    );
    // A container that is no Confera stack at all.
    started.push(
      docker([
        'run',
        '--detach',
        '--rm',
        '--publish',
        `127.0.0.1:${String(plainPort)}:1025`,
        image,
      ]),
    );
  });

  afterAll(() => {
    for (const id of started) {
      docker(['rm', '--force', id]);
    }
  });

  const refusals: [string, string[], Record<string, string>][] = [
    ['db:provision', [join('scripts', 'db-provision.mjs')], {}],
    [
      'db:provision of a test database with --reset',
      [join('scripts', 'db-provision.mjs'), '--database', 'confera_integration_test', '--reset'],
      {},
    ],
    ['seed:e2e', [join('scripts', 'seed-e2e.mjs')], { STAGE: 'test' }],
    [
      'the guard of db:migrate, db:status and db:diff',
      [
        join('scripts', 'stack.mjs'),
        'check-database',
        '--tool',
        'db:migrate',
        'MIGRATION_DATABASE_URL',
      ],
      {},
    ],
    [
      'the guard of start',
      [
        join('scripts', 'stack.mjs'),
        'check-database',
        '--tool',
        'start',
        'DATABASE_URL',
        'SYSTEM_DATABASE_URL',
      ],
      {},
    ],
  ];

  it.each(refusals)(
    '%s refuses the database of another checkout, names it and connects to nothing',
    async (_name, args, env) => {
      const result = await runNode(args, { env: { ...addressesAt(foreignPort), ...env } });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('did not run: the database of');
      expect(result.stderr).toContain(
        `at 127.0.0.1:${String(foreignPort)} belongs to the stack "confera-another-checkout" of another checkout, ${ELSEWHERE}`,
      );
      expect(result.stderr).toContain('corepack pnpm stack:ports');
      // It stopped before a connection: no sentence about PostgreSQL itself, no password.
      expect(result.output).not.toMatch(/cannot reach PostgreSQL|cannot connect|provisioned/);
      expect(result.output).not.toContain('local-only-');
    },
  );

  it('refuses a database that a container of no Confera stack serves', async () => {
    const result = await runNode([join('scripts', 'db-provision.mjs')], {
      env: addressesAt(plainPort),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`at 127.0.0.1:${String(plainPort)} is served by the container`);
    expect(result.stderr).toContain('which is not the stack of this checkout');
  });

  it("accepts the database of this checkout's own stack (the control)", async () => {
    const own = new URL(testDatabase.ownerUrl);
    const result = await runNode(
      [join('scripts', 'stack.mjs'), 'check-database', 'MIGRATION_DATABASE_URL'],
      { env: { MIGRATION_DATABASE_URL: own.toString() } },
    );
    expect({ exitCode: result.exitCode, output: result.output }).toEqual({
      exitCode: 0,
      output: '',
    });
  });

  describe('stack:up', () => {
    let squatter: Server;
    let squattedPort: number;

    beforeAll(async () => {
      squattedPort = await freePort();
      squatter = createServer();
      await new Promise<void>((resolve) => squatter.listen(squattedPort, '127.0.0.1', resolve));
    });

    afterAll(async () => {
      await new Promise<void>((resolve) =>
        squatter.close(() => {
          resolve();
        }),
      );
    });

    /** The ports of this checkout's own stack, which is up while these tests run. */
    const ownPorts = () => ({
      ...addressesAt(Number(new URL(testDatabase.ownerUrl).port || 5432)),
      CONFERA_MAIL_WEB_PORT: process.env.CONFERA_MAIL_WEB_PORT ?? '8025',
      CONFERA_MAIL_SMTP_PORT: process.env.CONFERA_MAIL_SMTP_PORT ?? '1025',
    });

    it('refuses a port that the stack of another checkout publishes, before Compose runs', async () => {
      const result = await runNode([join('scripts', 'stack.mjs'), 'up'], {
        env: { ...ownPorts(), CONFERA_MAIL_SMTP_PORT: String(foreignPort) },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `stack:up did not run: the SMTP port of the mail catcher at 127.0.0.1:${String(foreignPort)} belongs to the stack "confera-another-checkout" of another checkout`,
      );
      expect(result.output).not.toMatch(/Container .* (Started|Created)/);
    });

    it('refuses a port that another program listens on', async () => {
      const result = await runNode([join('scripts', 'stack.mjs'), 'up'], {
        env: { ...ownPorts(), CONFERA_MAIL_WEB_PORT: String(squattedPort) },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `port ${String(squattedPort)} of 127.0.0.1, for the web screen of the mail catcher, is in use by another program`,
      );
    });
  });
});
