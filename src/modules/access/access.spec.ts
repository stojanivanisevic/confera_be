import type { Request } from 'express';
import { RateLimiter } from '../../common/http/rate-limiter';
import { isMailAddress } from '../../common/validation/mail-address';
import { isBic, isIban, isSerbianAccount, isSerbianTaxNumber } from '../../common/validation/bank';
import { keptReport } from '../csp-reports/csp-reports.controller';
import { brakeDelayMs, BRAKE } from './brake.service';
import { cookieValue, DEVICE_COOKIE, SESSION_COOKIE } from './cookies';
import { csrfValueOf, digestOf, isToken, newToken, sameText } from './tokens';

/** The small parts of the access module, each on its own. */
describe('tokens', () => {
  it('a token is 43 characters of base64url, each one different, and only its SHA-256 is stored', () => {
    const tokens = Array.from({ length: 100 }, () => newToken());
    for (const token of tokens) {
      expect(isToken(token)).toBe(true);
      expect(digestOf(token)).toMatch(/^[0-9a-f]{64}$/);
      expect(digestOf(token)).not.toContain(token);
    }
    expect(new Set(tokens).size).toBe(100);
    expect(isToken('A'.repeat(42))).toBe(false);
    expect(isToken(`${'A'.repeat(42)}=`)).toBe(false);
  });

  it('the CSRF value is bound to the session token and differs between sessions', () => {
    const one = newToken();
    expect(csrfValueOf(one)).toBe(csrfValueOf(one));
    expect(csrfValueOf(one)).not.toBe(csrfValueOf(newToken()));
    expect(csrfValueOf(one)).not.toContain(one);
    expect(sameText('abc', 'abc')).toBe(true);
    expect(sameText('abc', 'abd')).toBe(false);
    expect(sameText('abc', 'ab')).toBe(false);
  });
});

describe('cookies', () => {
  const request = (cookie?: string) => ({ headers: { cookie } }) as Request;
  const token = newToken();

  it('reads exactly the named __Host- cookie', () => {
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(DEVICE_COOKIE.startsWith('__Host-')).toBe(true);
    expect(cookieValue(request(`${SESSION_COOKIE}=${token}`), SESSION_COOKIE)).toBe(token);
    expect(cookieValue(request(`a=b; ${SESSION_COOKIE}=${token}; c=d`), SESSION_COOKIE)).toBe(
      token,
    );
    expect(cookieValue(request(`confera_session=${token}`), SESSION_COOKIE)).toBeNull();
    expect(cookieValue(request(), SESSION_COOKIE)).toBeNull();
  });

  it('two cookies of one name are none, and a value that is no token is none', () => {
    expect(
      cookieValue(
        request(`${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${newToken()}`),
        SESSION_COOKIE,
      ),
    ).toBeNull();
    expect(cookieValue(request(`${SESSION_COOKIE}=x`), SESSION_COOKIE)).toBeNull();
    expect(cookieValue(request(`${SESSION_COOKIE}=`), SESSION_COOKIE)).toBeNull();
  });
});

describe('the brake', () => {
  it('costs nothing within the free failures, then doubles from 30 s to 15 minutes', () => {
    expect(brakeDelayMs(0, BRAKE.accountFreeFailures)).toBe(0);
    expect(brakeDelayMs(BRAKE.accountFreeFailures - 1, BRAKE.accountFreeFailures)).toBe(0);
    expect(brakeDelayMs(BRAKE.accountFreeFailures, BRAKE.accountFreeFailures)).toBe(30_000);
    expect(brakeDelayMs(BRAKE.accountFreeFailures + 1, BRAKE.accountFreeFailures)).toBe(60_000);
    expect(brakeDelayMs(BRAKE.accountFreeFailures + 20, BRAKE.accountFreeFailures)).toBe(
      BRAKE.longestDelayMs,
    );
  });
});

describe('the rate limiter', () => {
  it('counts per key and window, and forgets a window that has ended', () => {
    let now = 1_000;
    const limiter = new RateLimiter(2, 100, 10, () => now);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.isOver('a')).toBe(true);
    expect(limiter.take('b')).toBe(true);
    now += 100;
    expect(limiter.isOver('a')).toBe(false);
    expect(limiter.take('a')).toBe(true);
  });

  it('is bounded in keys: a flood of new keys drops the oldest', () => {
    const limiter = new RateLimiter(1, 1000, 3, () => 0);
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      limiter.take(key);
    }
    expect(limiter.isOver('a')).toBe(false);
    expect(limiter.isOver('e')).toBe(true);
  });
});

describe('the address rule (ST-23)', () => {
  it.each([
    'mila.petrovic@example.test',
    'a+b@sub.example.test',
    "o'neil@example.test",
    'x@xn--80ak6aa92e.test',
  ])('%s is one address', (address) => {
    expect(isMailAddress(address)).toBe(true);
  });

  it.each([
    'two@example.test, three@example.test',
    'Mila <mila@example.test>',
    'mila@example.test\r\nBcc: x@example.test',
    'mila@example',
    'mila@@example.test',
    '@example.test',
    'mila@example.test ',
    '.mila@example.test',
    'mila..p@example.test',
    `${'a'.repeat(65)}@example.test`,
    `mila@${'a'.repeat(240)}.test`,
    'mila@example.t3st',
    'mila@-example.test',
  ])('%s is not', (address) => {
    expect(isMailAddress(address)).toBe(false);
  });
});

describe('the identifiers on documents', () => {
  it('IBAN, BIC, a Serbian account and a tax number are checked by their published rules', () => {
    expect(isIban('RS35 2600 0560 1001 6113 79')).toBe(true);
    expect(isIban('RS35260005601001611378')).toBe(false);
    expect(isIban('DE89370400440532013000')).toBe(true);
    expect(isBic('BACXRSBG')).toBe(true);
    expect(isBic('BACXRSBGXXX')).toBe(true);
    expect(isBic('bacxrsbg')).toBe(false);
    expect(isSerbianAccount('160-0000000000123-95')).toBe(true);
    expect(isSerbianAccount('160-123-95')).toBe(true);
    expect(isSerbianAccount('160-0000000000123-96')).toBe(false);
    expect(isSerbianTaxNumber('100001100')).toBe(true);
    expect(isSerbianTaxNumber('100001101')).toBe(false);
    expect(isSerbianTaxNumber('12345678')).toBe(false);
  });
});

describe('a kept CSP report', () => {
  it('keeps the directive and the addresses without query, fragment or token, and the sample cut', () => {
    expect(
      keptReport({
        'csp-report': {
          'effective-directive': 'img-src',
          'blocked-uri': 'https://x.example/a.png?sig=secret#f',
          'document-uri':
            'https://forms.confera.test/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/view?x=1',
          'script-sample': 'x'.repeat(100),
          'status-code': 200,
        },
      }),
    ).toEqual({
      directive: 'img-src',
      blocked: 'https://x.example/a.png',
      document: 'https://forms.confera.test/s/[token]/view',
      disposition: 'report',
      status: 200,
      sample: 'x'.repeat(40),
    });
    expect(
      keptReport({
        body: {
          effectiveDirective: 'script-src',
          blockedURL: 'inline',
          documentURL: 'https://admin.confera.test/pay/tok',
        },
      }),
    ).toEqual(expect.objectContaining({ document: 'https://admin.confera.test/pay/[token]' }));
    expect(keptReport({ 'csp-report': { 'blocked-uri': 'x' } })).toBeNull();
    expect(keptReport('text')).toBeNull();
    expect(keptReport(null)).toBeNull();
  });
});
