import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as connectSocket } from 'node:net';
import { join } from 'node:path';
import { repoRoot, runNode } from '../support/run-node';
import { connect, e2eDatabase, rows } from './support/e2e-database';

/**
 * The development stack as the documented commands start it (M1-QA-02, ADR-24):
 * `pnpm stack:up` gives PostgreSQL and the mail catcher, `pnpm db:provision` the three
 * roles. These tests talk to the running stack: they find out whether the commands of
 * the README really produce what the end-to-end tests of both repositories stand on.
 *
 * The stub slot (`pnpm stubs`) needs no Docker and is tested in test/tooling.
 */

/** The ports of the mail catcher of THIS checkout's stack (.env; README, section 2). */
const MAILPIT = `http://127.0.0.1:${process.env.CONFERA_MAIL_WEB_PORT ?? '8025'}`;
const SMTP_PORT = Number(process.env.CONFERA_MAIL_SMTP_PORT ?? '1025');

/** One SMTP conversation: each line is sent after the server's answer to the one before. */
function smtp(lines: readonly string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(SMTP_PORT, '127.0.0.1');
    const answers: string[] = [];
    let step = 0;
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => {
      socket.destroy(new Error('the mail catcher did not answer within 10 s'));
    });
    socket.on('error', reject);
    socket.on('data', (chunk: string) => {
      answers.push(chunk.trim());
      const line = lines[step];
      step += 1;
      if (line === undefined) {
        socket.end();
        resolve(answers);
      } else {
        socket.write(`${line}\r\n`);
      }
    });
  });
}

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

describe('the development stack', () => {
  jest.setTimeout(120_000);

  describe('PostgreSQL', () => {
    it.each([
      ['application', () => e2eDatabase.applicationUrl, 'confera_app'],
      ['system', () => e2eDatabase.systemUrl, 'confera_system'],
      ['owner', () => e2eDatabase.ownerUrl, 'confera_owner'],
    ])('accepts the %s role of db:provision', async (_kind, address, name) => {
      const client = await connect(address());
      try {
        const [who] = await rows<{ current_user: string; encoding: string }>(
          client,
          "SELECT current_user, current_setting('server_encoding') AS encoding",
        );
        expect(who).toEqual({ current_user: name, encoding: 'UTF8' });
      } finally {
        await client.end();
      }
    });

    it('is reachable on the loopback address only, as docker-compose.yml publishes it', () => {
      const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
      // `- '127.0.0.1:${CONFERA_DB_PORT:?...}:5432'`: the host port is this checkout's own
      // (M1-ISS-13), the address in front of it is always the loopback address.
      const published = [...compose.matchAll(/^\s*-\s*'([^']+)'/gm)]
        .map((match) => match[1] ?? '')
        .filter((entry) => /:\d+$/.test(entry) && !entry.includes('/'));
      expect(published.map((entry) => /:(\d+)$/.exec(entry)?.[1]).sort()).toEqual([
        '1025',
        '5432',
        '8025',
      ]);
      for (const entry of published) {
        expect(entry).toMatch(/^127\.0\.0\.1:\$\{CONFERA_[A-Z_]+_PORT:\?[^}]+\}:\d+$/);
      }
    });

    it('db:provision is safe to repeat and prints no password', async () => {
      const result = await runNode(
        [join('scripts', 'db-provision.mjs'), '--database', e2eDatabase.name],
        {
          env: {
            DATABASE_URL: e2eDatabase.applicationUrl,
            SYSTEM_DATABASE_URL: e2eDatabase.systemUrl,
            MIGRATION_DATABASE_URL: e2eDatabase.ownerUrl,
            POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
          },
        },
      );
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: '',
      });
      expect(result.stdout).toContain(`Database "${e2eDatabase.name}" is provisioned.`);
      for (const address of [
        e2eDatabase.applicationUrl,
        e2eDatabase.systemUrl,
        e2eDatabase.ownerUrl,
      ]) {
        expect(result.output).not.toContain(new URL(address).password);
      }
      expect(result.output).not.toContain(process.env.POSTGRES_PASSWORD);
      expect(result.output).not.toContain('postgresql://');
    });

    it('prisma migrate status prints no password and finds the schema up to date', async () => {
      const result = await runNode(
        [join('node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'status'],
        { env: { MIGRATION_DATABASE_URL: e2eDatabase.ownerUrl } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Database schema is up to date');
      expect(result.output).not.toContain(new URL(e2eDatabase.ownerUrl).password);
    });
  });

  describe('the mail catcher (Mailpit)', () => {
    it('answers on its web port', async () => {
      const response = await fetch(`${MAILPIT}/api/v1/info`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        expect.objectContaining({ Version: expect.stringMatching(/^v\d+\.\d+/) }),
      );
    });

    it('catches a message sent to its SMTP port, with š č ć ž đ, and hands it back', async () => {
      const marker = `e2e-${randomBytes(6).toString('hex')}`;
      const body = 'Poštovana Živana, vaš predračun je spreman. Đorđe Čolić, ćošak.';
      const answers = await smtp([
        'HELO confera.test',
        'MAIL FROM:<no-reply@confera.example.test>',
        'RCPT TO:<zivana.djordjevic@a.example.test>',
        'DATA',
        [
          'From: Confera <no-reply@confera.example.test>',
          'To: zivana.djordjevic@a.example.test',
          `Subject: Confera stack test ${marker}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          body,
          '.',
        ].join('\r\n'),
        'QUIT',
      ]);
      expect(answers[0]).toMatch(/^220 /);
      expect(answers.at(-2)).toMatch(/^250 /);

      const search = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${marker}"`)}`,
      );
      const found = (await search.json()) as { messages: MailpitMessage[] };
      expect(found.messages).toHaveLength(1);
      const message = found.messages[0]!;
      try {
        expect(message.To.map((to) => to.Address)).toEqual(['zivana.djordjevic@a.example.test']);
        const detail = await fetch(`${MAILPIT}/api/v1/message/${message.ID}`);
        const { Text } = (await detail.json()) as { Text: string };
        expect(Text.trim()).toBe(body);
      } finally {
        // The catcher is shared with the developer: the test takes its message away again.
        await fetch(`${MAILPIT}/api/v1/messages`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ IDs: [message.ID] }),
        });
      }
      const after = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${marker}"`)}`,
      );
      expect(((await after.json()) as { messages: MailpitMessage[] }).messages).toEqual([]);
    });
  });
});
