import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runNode } from '../support/run-node';

/**
 * The scan for literal values assigned to names like a secret
 * (scripts/lib/secret-assignments.mjs; defect D2 of the 0.1.0 verification: a mail
 * password, a PayPal client secret and a data key have no format that secretlint knows).
 *
 * Every fake secret is made at run time and every assignment is put together from its
 * parts, so that this file holds nothing the scan itself would report.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function random(length: number): string {
  return Array.from(randomBytes(length), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** `NAME=value` and the like, never written as one piece of text. */
function assign(name: string, value: string, separator = '=', quote = ''): string {
  return [name, separator, quote, value, quote].join('');
}

interface Scan {
  readonly exitCode: number | null;
  readonly output: string;
  /** `file:line name` of every finding. */
  readonly findings: string[];
}

async function scan(files: Record<string, string>): Promise<Scan> {
  const root = mkdtempSync(join(tmpdir(), 'confera-assignments-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const result = await runNode([join('scripts', 'secret-assignments.mjs'), root]);
    const findings: string[] = [];
    let current = '';
    for (const line of result.stdout.split(/\r?\n/)) {
      const finding = /^ {2}(\d+) {2}error .*assigned to "([^"]+)"/.exec(line);
      if (finding) {
        findings.push(`${current}:${finding[1] ?? ''} ${finding[2] ?? ''}`);
      } else if (line.trim() !== '') {
        current = line.replaceAll('\\', '/').split('/').slice(-2).join('/');
      }
    }
    return { exitCode: result.exitCode, output: result.output, findings };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('scan for values assigned to names like a secret', () => {
  jest.setTimeout(120_000);

  it('reports a mail password, a client secret and a data key in environment files', async () => {
    const smtp = random(24);
    const paypal = random(80);
    const dataKey = randomBytes(32).toString('hex');
    const result = await scan({
      'deploy/server.env': ['STAGE=prod', assign('SMTP_PASSWORD', smtp), ''].join('\n'),
      'deploy/payments.env': [
        assign('PAYPAL_CLIENT_SECRET', paypal),
        assign('DATA_KEY', dataKey),
        '',
      ].join('\n'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.sort()).toEqual([
      'deploy/payments.env:1 PAYPAL_CLIENT_SECRET',
      'deploy/payments.env:2 DATA_KEY',
      'deploy/server.env:2 SMTP_PASSWORD',
    ]);
    // A finding names the variable and never shows the value.
    for (const value of [smtp, paypal, dataKey]) {
      expect(result.output).not.toContain(value);
    }
  });

  it.each([
    ['with export', (v: string) => `export ${assign('API_TOKEN', v)}`],
    ['with spaces around the sign', (v: string) => assign('SIGNING_KEY ', ` ${v}`)],
    ['in double quotes', (v: string) => assign('MAIL_PASSWD', v, '=', '"')],
    ['in single quotes', (v: string) => assign('SERVICE_CREDENTIALS', v, '=', "'")],
    ['with a comment after it', (v: string) => `${assign('WEBHOOK_SECRET', v)} # rotate yearly`],
    ['as a YAML entry', (v: string) => `    ${assign('SMTP_PASSWORD', v, ': ')}`],
    ['a short real password', () => assign('SMTP_PASSWORD', 'hunter2!')],
    ['a word that is not the documented placeholder', () => assign('SMTP_PASSWORD', 'changeme')],
  ])('reports an assignment %s', async (_name, build) => {
    const result = await scan({ 'deploy/compose.env': `${build(random(20))}\n` });
    expect(result.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it('does not report placeholders, references, empty values and names that only look alike', async () => {
    const result = await scan({
      'deploy/template.env': [
        assign('POSTGRES_PASSWORD', 'local-only-superuser'),
        assign('SMTP_PASSWORD', 'invented-mail-password'),
        assign('DATA_KEY', ''),
        assign('API_TOKEN', '${API_TOKEN}'),
        assign('PAYPAL_CLIENT_SECRET', '<set-on-the-server>'),
        assign('SESSION_TOKEN_TTL', '86400000'),
        assign('DATA_KEY_FILE', '/run/secrets/data_key'),
        assign('TOKEN_URL', 'https://example.test/oauth/token'),
        assign('KEYWORDS', 'conference,membership'),
        assign('MONKEY_BUSINESS', random(20)),
        assign('STAGE', 'production'),
        assign('SMTP_PASSWORD', 'short'),
        `# ${assign('SMTP_PASSWORD', 'is set on the server by the operator')}`,
        '',
      ].join('\n'),
    });
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  describe('in source code', () => {
    it('reports a quoted value assigned to a name like a secret', async () => {
      const result = await scan({
        'src/mail.ts': [
          'export const config = {',
          `  ${assign('smtpPassword', random(12), ': ', "'")},`,
          `  ${assign('"client_secret"', random(40), ': ', '"')},`,
          `  ${assign('dataKey', randomBytes(32).toString('hex'), ': ', "'")},`,
          '};',
          `const ${assign('apiToken', random(30), ' = ', "'")};`,
          '',
        ].join('\n'),
        'config/settings.json': `{ ${assign('"webhookSecret"', random(32), ': ', '"')} }\n`,
      });
      expect(result.findings.sort()).toEqual([
        'config/settings.json:1 webhookSecret',
        'src/mail.ts:2 smtpPassword',
        'src/mail.ts:3 client_secret',
        'src/mail.ts:4 dataKey',
        'src/mail.ts:6 apiToken',
      ]);
    });

    it('does not report expressions, references, short test values or other names', async () => {
      const result = await scan({
        'src/sample.ts': [
          'export const settings = {',
          '  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,',
          '  password: body.password,',
          '  token: generateToken(),',
          `  ${assign('password', 'canary', ': ', "'")},`,
          `  ${assign('apiKey', 'invented-api-key-0001', ': ', "'")},`,
          `  ${assign('passwordHash', 'local-only-hash', ': ', "'")},`,
          '  clientSecret: `${prefix}-suffix-of-the-secret`,',
          `  ${assign('keywords', 'conference, membership and a long text', ': ', "'")},`,
          `  ${assign('primaryKey', 'organisation_id', ': ', "'")},`,
          `  ${assign('tokenHeader', 'X-Form-Token-Name', ': ', "'")},`,
          `  ${assign('passwordField', 'new_password_again', ': ', "'")},`,
          '  secret: false,',
          '};',
          'const SECRET_LIKE = /password|secret|token/i;',
          '',
        ].join('\n'),
      });
      expect(result.findings).toEqual([]);
    });
  });

  it('scans what git would take and nothing else', async () => {
    const result = await scan({
      '.gitignore': ['.env', 'node_modules/', 'dist/', ''].join('\n'),
      '.env': `${assign('SMTP_PASSWORD', random(20))}\n`,
      'node_modules/pkg/config.env': `${assign('SMTP_PASSWORD', random(20))}\n`,
      'dist/config.env': `${assign('SMTP_PASSWORD', random(20))}\n`,
      'deploy/taken.env': `${assign('SMTP_PASSWORD', random(20))}\n`,
    });
    expect(result.findings).toEqual(['deploy/taken.env:1 SMTP_PASSWORD']);
  });

  it('finds nothing in this repository', async () => {
    const result = await runNode([join('scripts', 'secret-assignments.mjs')]);
    expect({ exitCode: result.exitCode, output: result.output }).toEqual({
      exitCode: 0,
      output: '',
    });
  });
});
