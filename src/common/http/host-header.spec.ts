import { isMatchableHost, parseHostHeader } from './host-header';

/**
 * The strict reading of the Host header (ADR-02, SEC-A-50; defect D1 of the 0.1.0
 * verification: a URL parser found the admin host name inside headers that are no host).
 */
describe('parseHostHeader', () => {
  describe('a host, with or without a port', () => {
    it.each<[string, string, number | undefined]>([
      ['admin.confera.test', 'admin.confera.test', undefined],
      ['admin.confera.test:443', 'admin.confera.test', 443],
      ['admin.confera.test:8443', 'admin.confera.test', 8443],
      ['ADMIN.Confera.TEST:3001', 'admin.confera.test', 3001],
      ['localhost', 'localhost', undefined],
      ['localhost:3001', 'localhost', 3001],
      ['127.0.0.1', '127.0.0.1', undefined],
      ['127.0.0.1:3001', '127.0.0.1', 3001],
      ['[::1]', '[::1]', undefined],
      ['[::1]:3001', '[::1]', 3001],
      ['[2001:DB8::1]:443', '[2001:db8::1]', 443],
      ['xn--konferencija-9db.example', 'xn--konferencija-9db.example', undefined],
      ['a-b.c-d.example:0', 'a-b.c-d.example', 0],
      ['host:65535', 'host', 65535],
    ])('%s', (header, hostname, port) => {
      expect(parseHostHeader(header)).toEqual({ hostname, port });
    });

    it('accepts a label of 63 characters and a name of 253', () => {
      const label = 'a'.repeat(63);
      expect(parseHostHeader(`${label}.example`)?.hostname).toBe(`${label}.example`);
      const longest = [label, label, label, 'b'.repeat(61)].join('.');
      expect(longest).toHaveLength(253);
      expect(parseHostHeader(longest)?.hostname).toBe(longest);
    });
  });

  describe('not a host', () => {
    const ADMIN = 'admin.confera.test';

    it.each<[string, string | undefined]>([
      ['missing', undefined],
      ['empty', ''],
      ['a user part before the name', `evil.example@${ADMIN}`],
      ['a user and a password before the name', `user:pw@${ADMIN}`],
      ['the name as the user part of another host', `${ADMIN}@evil.example`],
      ['the name with a password part', `${ADMIN}:x@evil.example`],
      ['a path after the name', `${ADMIN}/evil.example`],
      ['a query after the name', `${ADMIN}?evil.example`],
      ['a fragment after the name', `${ADMIN}#evil.example`],
      ['a backslash after the name', `${ADMIN}\\evil.example`],
      ['a percent-encoded letter', '%61dmin.confera.test'],
      ['a trailing dot', `${ADMIN}.`],
      ['a leading dot', `.${ADMIN}`],
      ['two dots in a row', 'admin..confera.test'],
      ['two names', `${ADMIN}, evil.example`],
      ['a space in the name', 'admin .confera.test'],
      ['a space around the name', ` ${ADMIN} `],
      ['a tab', `${ADMIN}\t`],
      ['a scheme', `http://${ADMIN}`],
      ['an underscore', 'admin_host.confera.test'],
      ['a label that starts with a hyphen', '-admin.confera.test'],
      ['a label that ends with a hyphen', 'admin-.confera.test'],
      // U+0430, the Cyrillic letter that looks like the Latin "a".
      ['a letter that only looks Latin', `${String.fromCodePoint(0x430)}dmin.confera.test`],
      ['a port that is not a number', `${ADMIN}:http`],
      ['an empty port', `${ADMIN}:`],
      ['a port that is too large', `${ADMIN}:65536`],
      ['a port with six digits', `${ADMIN}:099999`],
      ['a negative port', `${ADMIN}:-1`],
      ['two ports', `${ADMIN}:80:80`],
      ['a label of 64 characters', `${'a'.repeat(64)}.example`],
      [
        'a name of 254 characters',
        ['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'b'.repeat(62)].join('.'),
      ],
      ['a very long name', `${'a'.repeat(4000)}.${ADMIN}`],
      ['an IPv6 address without brackets', '::1'],
      ['an unclosed bracket', '[::1'],
      ['brackets around a name', `[${ADMIN}]`],
      ['text after the bracket', '[::1]x'],
      ['empty brackets', '[]'],
      ['a wildcard', '*.confera.test'],
      ['a null character', `${ADMIN}\u0000`],
    ])('%s', (_name, header) => {
      expect(parseHostHeader(header)).toBeUndefined();
    });
  });

  describe('isMatchableHost', () => {
    it('says whether a configured host can ever equal a Host header', () => {
      expect(isMatchableHost('admin.confera.test')).toBe(true);
      expect(isMatchableHost('admin.confera.test:8443')).toBe(true);
      expect(isMatchableHost('[::1]:3000')).toBe(true);
      expect(isMatchableHost('admin_host.confera.test')).toBe(false);
    });
  });
});
