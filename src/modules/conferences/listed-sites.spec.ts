import { isTimeZone, MAX_LISTED_SITES, normaliseSite, normaliseSites } from './listed-sites';

/** ST-30: the listed sites of a conference (ADR-07, SEC-A-08), refused or normalised. */
describe('listed sites (ST-30)', () => {
  it.each([
    ['a wildcard', 'https://*.itema-conference.com', 'wildcard'],
    ['a bare wildcard', '*', 'wildcard'],
    ['a path', 'https://www.itema-conference.com/forms', 'path'],
    ['http: outside a developer machine', 'http://www.itema-conference.com', 'scheme'],
    ['another scheme', 'javascript://www.itema-conference.com', 'scheme'],
    ['a space inside', 'https://www.itema conference.com', 'forbidden_character'],
    [
      'a second source after a space',
      'https://a.example.test https://b.example.test',
      'forbidden_character',
    ],
    ['a semicolon', "https://a.example.test;script-src 'unsafe-inline'", 'forbidden_character'],
    ['a comma', 'https://a.example.test,https://b.example.test', 'forbidden_character'],
    ['a quote', "https://a.example.test'", 'forbidden_character'],
    ['a user part', 'https://user@www.itema-conference.com', 'user_part'],
    [
      'a user and password',
      ['https://user', 'invented@www.itema-conference.com'].join(':'),
      'user_part',
    ],
    ['a query', 'https://www.itema-conference.com/?x=1', 'query'],
    ['a fragment', 'https://www.itema-conference.com#top', 'query'],
    ['no scheme', 'www.itema-conference.com', 'not_a_url'],
    ['nothing', '', 'not_a_url'],
  ])('refuses %s', (_name, entry, problem) => {
    expect(normaliseSite(entry, 'prod')).toEqual({ ok: false, problem });
  });

  it.each([
    ['upper case', 'HTTPS://WWW.ITEMA-CONFERENCE.COM', 'https://www.itema-conference.com'],
    ['a trailing slash', 'https://eraz-conference.com/', 'https://eraz-conference.com'],
    ['spaces around', '  https://eman-conference.org  ', 'https://eman-conference.org'],
    ['the default port', 'https://limen-conference.com:443', 'https://limen-conference.com'],
    [
      'another port, kept',
      'https://limen-conference.com:8443',
      'https://limen-conference.com:8443',
    ],
    [
      'a name with š and đ, in punycode',
      'https://šđ.example.test',
      'https://xn--fea3n.example.test',
    ],
  ])('normalises %s', (_name, entry, origin) => {
    expect(normaliseSite(entry, 'prod')).toEqual({ ok: true, origin });
  });

  it('allows http: on a developer machine only (STAGE local)', () => {
    expect(normaliseSite('http://localhost:3000', 'local')).toEqual({
      ok: true,
      origin: 'http://localhost:3000',
    });
    expect(normaliseSite('http://localhost:3000', 'test')).toEqual({
      ok: false,
      problem: 'scheme',
    });
    expect(normaliseSite('http://localhost:3000', 'dev')).toEqual({ ok: false, problem: 'scheme' });
  });

  it('keeps one of two entries with the same origin', () => {
    expect(normaliseSites(['https://a.example.test', 'HTTPS://A.EXAMPLE.TEST/'], 'prod')).toEqual({
      ok: true,
      sites: ['https://a.example.test'],
    });
  });

  it('takes 20 entries and refuses a 21st', () => {
    const entries = Array.from(
      { length: MAX_LISTED_SITES + 1 },
      (_, index) => `https://site${String(index)}.example.test`,
    );
    expect(normaliseSites(entries.slice(0, MAX_LISTED_SITES), 'prod')).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(normaliseSites(entries, 'prod')).toEqual({
      ok: false,
      index: MAX_LISTED_SITES,
      problem: 'too_many',
    });
  });

  it('names the entry that is refused', () => {
    expect(normaliseSites(['https://a.example.test', 'https://*.example.test'], 'prod')).toEqual({
      ok: false,
      index: 1,
      problem: 'wildcard',
    });
  });

  it('knows the time zones', () => {
    expect(isTimeZone('Europe/Belgrade')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Europe/Novi_Sad')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});
