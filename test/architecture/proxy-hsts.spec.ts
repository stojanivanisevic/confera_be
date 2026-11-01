import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../support/run-node';

/**
 * SEC-STG-05 (condition 4 of the Security reviewer's review of staging under congresa.com,
 * 2026-10-31): staging (admin., forms. and mail.staging.congresa.com) shares the registrable
 * domain of production, so the proxy's HSTS is exactly `max-age=31536000`, without
 * `includeSubDomains` and without `preload`. deploy/checks/topology.mjs proves it on the
 * running proxy (Docker); this test holds every file of deploy/proxy to it in every
 * `pnpm check`, without Docker.
 */

const PROXY = join(repoRoot, 'deploy', 'proxy');
const HSTS = 'max-age=31536000';

interface Setting {
  readonly line: number;
  /** The header operation (`+`, `>`, `?`, `-`, `~` or nothing) and the rest of the line. */
  readonly operation: string;
  readonly rest: string;
}

/** The lines Caddy reads, with their numbers: comments dropped (a `#` that starts a token). */
function directives(text: string): { line: number; text: string }[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.replace(/(^|\s)#.*$/, '').trim() }))
    .filter(({ text: directive }) => directive !== '');
}

/** Every place a Caddy file names the HSTS header, in a `header` line or block or a `header_down`. */
function settings(text: string): Setting[] {
  return directives(text).flatMap(({ line, text: directive }) => {
    const match = /(?:^|[\s{])([+>?~-]?)strict-transport-security\b(.*)$/i.exec(directive);
    return match === null
      ? []
      : [{ line, operation: match[1] ?? '', rest: (match[2] ?? '').trim() }];
  });
}

/** What is wrong with a file's HSTS: one line per setting that is not exactly one year. */
function problems(file: string, text: string): string[] {
  const found = settings(text)
    .filter(({ operation, rest }) => !['', '>'].includes(operation) || rest !== `"${HSTS}"`)
    .map(({ line, operation, rest }) => `${file}:${String(line)}: ${operation}${rest}`);
  const asked = directives(text)
    .filter(({ text: directive }) => /includesubdomains|preload/i.test(directive))
    .map(({ line, text: directive }) => `${file}:${String(line)}: ${directive}`);
  return [...found, ...asked];
}

const files = readdirSync(PROXY)
  .filter((name) => name === 'Caddyfile' || name.endsWith('.caddy'))
  .map((name) => ({ name, text: readFileSync(join(PROXY, name), 'utf8') }));

describe('HSTS is exactly one year, without includeSubDomains or preload (SEC-STG-05)', () => {
  it('reads every file of the proxy', () => {
    expect(files.map(({ name }) => name).sort()).toEqual(
      ['Caddyfile', 'gate-production.caddy', 'gate-staging.caddy', 'mail-staging.caddy'].sort(),
    );
  });

  describe('the scan finds every other value', () => {
    it.each([
      [
        'includeSubDomains',
        'header Strict-Transport-Security "max-age=31536000; includeSubDomains"',
      ],
      [
        'preload in a block',
        'header {\n\tStrict-Transport-Security "max-age=31536000; preload"\n}',
      ],
      ['another age', 'header >Strict-Transport-Security "max-age=63072000"'],
      ['a value added beside it', 'header +Strict-Transport-Security "max-age=31536000"'],
      ['the header removed', 'header -Strict-Transport-Security'],
      [
        'the upstream value kept',
        'reverse_proxy web:3000 {\n\theader_down Strict-Transport-Security "max-age=1"\n}',
      ],
      [
        'lower case, no quotes',
        'header strict-transport-security max-age=31536000;includeSubDomains',
      ],
      ['a value from the environment', 'header Strict-Transport-Security {$HSTS}'],
      ['preload anywhere', 'header X-Other "preload"'],
    ])('%s', (_name, text) => {
      expect(problems('sample.caddy', text).length).toBeGreaterThan(0);
    });

    it.each([
      ['the value itself', 'header Strict-Transport-Security "max-age=31536000"'],
      [
        'the value in a block',
        'header {\n\tStrict-Transport-Security "max-age=31536000"\n\t-Server\n}',
      ],
      ['a comment', '# Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"'],
    ])('and leaves alone %s', (_name, text) => {
      expect(problems('sample.caddy', text)).toEqual([]);
    });
  });

  it('the Caddyfile sets it, exactly max-age=31536000', () => {
    const caddyfile = files.find(({ name }) => name === 'Caddyfile')?.text ?? '';
    expect(settings(caddyfile).map(({ operation, rest }) => `${operation}${rest}`)).toEqual([
      `"${HSTS}"`,
    ]);
  });

  it('no file of the proxy sets it otherwise, or asks for includeSubDomains or preload', () => {
    expect(files.flatMap(({ name, text }) => problems(name, text))).toEqual([]);
  });

  it('the Caddyfile says at the header that it is deliberate and needs the Security reviewer', () => {
    const lines = (files.find(({ name }) => name === 'Caddyfile')?.text ?? '').split(/\r?\n/);
    const at = lines.findIndex((line) => /^\s*Strict-Transport-Security\s/.test(line));
    const comment = lines[at - 1] ?? '';
    expect(comment).toMatch(/^\s*#/);
    expect(comment).toMatch(/without includeSubDomains and preload/);
    expect(comment).toMatch(/Security reviewer/);
  });
});
