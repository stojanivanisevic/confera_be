import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Response } from 'express';
import * as cookies from '../../src/modules/access/cookies';
import { repoRoot } from '../support/run-node';
import { cookieDomains, cookieWrites } from './source-scan';

/**
 * The cookie rule (condition 5 of the Security reviewer's review of staging under
 * congresa.com, 2026-10-31). Staging (admin., forms. and mail.staging.congresa.com) shares
 * the registrable domain of production, so a cookie that one of them could set for the
 * parent domain would reach the others. Every cookie of the API is therefore `__Host-`
 * prefixed, `Secure`, `Path=/` and without `Domain` (ADR-03, SEC-A-50), which a browser
 * accepts only from the host itself. Three facts keep that true:
 *
 * 1. only src/modules/access/cookies.ts writes a cookie: no other file names the header
 *    Set-Cookie, calls the framework's cookie API or imports a cookie library;
 * 2. no text in src carries a `Domain=` attribute;
 * 3. what cookies.ts writes, for each of its cookies, is `__Host-`, `Secure`, `Path=/` and
 *    has no `Domain`.
 *
 * The scans read the syntax tree of every source file, and each is first shown the code it
 * must find.
 */

const SRC = join(repoRoot, 'src');
const COOKIE_FILE = 'src/modules/access/cookies.ts';

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
/** What runs in the API. A spec reads the cookies of a response; it sends none to a browser. */
const applicationFiles = files.filter(({ name }) => !name.endsWith('.spec.ts'));

/** The Set-Cookie lines that a call of cookies.ts appends to a response. */
function written(write: (response: Response) => void): string[] {
  const lines: string[] = [];
  const response = {
    append(name: string, value: string) {
      expect(name).toBe('Set-Cookie');
      lines.push(value);
      return response;
    },
  };
  write(response as unknown as Response);
  return lines;
}

describe('every cookie is __Host-, Secure, Path=/ and has no Domain (condition 5)', () => {
  it('reads the source tree, cookies.ts among it', () => {
    expect(applicationFiles.length).toBeGreaterThan(30);
    expect(applicationFiles.map(({ name }) => name)).toContain(COOKIE_FILE);
  });

  describe('1. only cookies.ts writes a cookie', () => {
    describe('the scan finds every way of writing one', () => {
      it.each([
        ['the header appended', "response.append('Set-Cookie', 'a=b; Path=/');"],
        ['the header set, lower case', "response.setHeader('set-cookie', ['a=b']);"],
        ['the header set, upper case', "response.header('SET-COOKIE', 'a=b');"],
        ['the header in an object', "response.set({ 'Set-Cookie': 'a=b' });"],
        ['the header in a template', 'response.append(`Set-Cookie`, `${n}=${v}`);'],
        ['the cookie API', "response.cookie('a', 'b', { secure: true });"],
        ['the cookie API, clearing', "response.clearCookie('a');"],
        ['the cookie API, computed', "response['cookie']('a', 'b');"],
        ['a cookie library', "import { serialize } from 'cookie';\nexport const s = serialize;"],
        [
          'cookie-parser',
          "import cookieParser from 'cookie-parser';\nexport const c = cookieParser;",
        ],
        ['a library through require', "export const c = require('cookie-session');"],
        ['a library through a dynamic import', "export const c = () => import('express-session');"],
        ['a re-export of a library', "export { serialize } from 'cookie';"],
      ])('%s', (_name, code) => {
        expect(cookieWrites('sample.ts', code).length).toBeGreaterThan(0);
      });

      it.each([
        ['reading the cookies of a request', 'export const c = (r: any) => r.headers.cookie;'],
        ['a call of cookies.ts', "setCookie(response, SESSION_COOKIE, 'v', 60);"],
        ['the word in a comment', '// Set-Cookie and response.cookie()\nexport const a = 1;'],
        ['the word cookie in a text', "export const s = 'the session cookie expired';"],
      ])('and leaves alone %s', (_name, code) => {
        expect(cookieWrites('sample.ts', code)).toEqual([]);
      });
    });

    it('in src, cookies.ts and no other file writes a cookie', () => {
      const writers = applicationFiles
        .map(({ name, text }) => ({ name, findings: cookieWrites(name, text) }))
        .filter(({ findings }) => findings.length > 0)
        .map(({ name }) => name);
      expect(writers).toEqual([COOKIE_FILE]);
    });
  });

  describe('2. no text in src carries a Domain attribute', () => {
    describe('the scan finds it in every spelling', () => {
      it.each([
        ['in a text', "export const c = 'a=b; Path=/; Domain=congresa.com';"],
        ['lower case', "export const c = 'a=b; domain=.congresa.com';"],
        ['with spaces', "export const c = 'a=b; Domain = congresa.com';"],
        ['in a template', 'export const c = `${n}=${v}; Domain=${host}; Secure`;'],
      ])('%s', (_name, code) => {
        expect(cookieDomains('sample.ts', code).length).toBeGreaterThan(0);
      });

      it.each([
        ['a comment', '// no Domain= here\nexport const a = 1;'],
        ['the word alone', "export const s = 'the domain of the organisation';"],
      ])('and leaves alone %s', (_name, code) => {
        expect(cookieDomains('sample.ts', code)).toEqual([]);
      });
    });

    it('in src, specs included, no text has one', () => {
      expect(files.flatMap(({ name, text }) => cookieDomains(name, text))).toEqual([]);
    });
  });

  describe('3. what cookies.ts writes', () => {
    const names = Object.entries(cookies)
      .filter(([key, value]) => key.endsWith('_COOKIE') && typeof value === 'string')
      .map(([, value]) => value as string);

    it('names its cookies with the __Host- prefix', () => {
      expect(names.sort()).toEqual([cookies.DEVICE_COOKIE, cookies.SESSION_COOKIE].sort());
      for (const name of names) {
        expect(name).toMatch(/^__Host-[a-z_]+$/);
      }
    });

    it.each([
      [
        'set',
        (name: string) => (r: Response) => {
          cookies.setCookie(r, name, 'v'.repeat(43), 60);
        },
      ],
      [
        'cleared',
        (name: string) => (r: Response) => {
          cookies.clearCookie(r, name);
        },
      ],
    ])('a cookie %s is __Host-, Secure, Path=/ and has no Domain', (_how, write) => {
      for (const name of names) {
        const lines = written(write(name));
        expect(lines).toHaveLength(1);
        const [pair = '', ...attributes] = (lines[0] ?? '').split(';').map((part) => part.trim());
        expect(pair.startsWith(`${name}=`)).toBe(true);
        expect(attributes).toContain('Secure');
        expect(attributes).toContain('Path=/');
        expect(attributes.filter((attribute) => /^domain\b/i.test(attribute))).toEqual([]);
      }
    });
  });
});
