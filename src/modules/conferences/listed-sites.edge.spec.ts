import { isTimeZone, normaliseSite } from './listed-sites';

/**
 * Edge cases of 0.2.0 found by the edge-case hunter (E2). Each test below fails today, for
 * the reason in its comment.
 */

/** What a CSP host source and an Origin may hold: letters, digits, dot, hyphen, colon, brackets. */
const ORIGIN = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/;

describe('listed sites: forms that reach the stored origin by another way (E2-01)', () => {
  // ST-30 / ADR-07 / SEC-A-08: "nothing of that kind may reach a header". The check looks at
  // the TEXT typed, but the URL parser decodes percent-escapes and folds full-width letters
  // AFTER it, and it lets ";" "," and "'" stand in a host name. 0.3.0 writes the stored origin
  // into `frame-ancestors`, where a ";" starts another directive and a "," another policy.
  it.each([
    ['a percent-encoded semicolon', 'https://a%3Bscript-src.example.test'],
    ['a percent-encoded comma', 'https://a%2Cb.example.test'],
    ['a percent-encoded apostrophe', 'https://a%27b.example.test'],
    ['a percent-encoded double quote', 'https://a%22b.example.test'],
    ['a full-width semicolon', 'https://a；script-src.example.test'],
    ['a full-width comma', 'https://a，b.example.test'],
    ['a full-width apostrophe', 'https://a＇b.example.test'],
  ])('does not store %s in an origin', (_name, entry) => {
    const result = normaliseSite(entry, 'prod');
    if (result.ok) {
      expect(result.origin).toMatch(ORIGIN);
    }
    expect(result.ok).toBe(false);
  });
});

describe('time zones: a valid IANA zone is a valid time zone (E2-10)', () => {
  // `isTimeZone` asks `Intl.supportedValuesOf('timeZone').includes(value)`, which on Node 22
  // lists the older CLDR names: "Asia/Kolkata", "Europe/Kyiv" and "Etc/UTC" are refused,
  // although `Intl.DateTimeFormat` knows them and a browser offers them (FR-CONF-01: a time
  // zone per conference; the Balkans' neighbours and partners meet in these zones).
  it.each([
    'Asia/Kolkata',
    'Europe/Kyiv',
    'Etc/UTC',
    'America/Argentina/Buenos_Aires',
    'Asia/Kathmandu',
  ])('accepts %s', (zone) => {
    expect(new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone).not.toBe(
      '',
    );
    expect(isTimeZone(zone)).toBe(true);
  });
});
