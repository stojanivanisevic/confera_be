import { Secret } from '../../config/secret';
import { isRedactedName, redact, REDACTED, scrubText } from './redact';

describe('redaction of log entries (ADR-19, SEC-A-28)', () => {
  describe('by property name', () => {
    it.each([
      'password',
      'Password',
      'newPassword',
      'current_password',
      'passwordHash',
      'password_hash',
      'secret',
      'clientSecret',
      'token',
      'accessToken',
      'x-csrf-token',
      'csrfToken',
      'formToken',
      'authorization',
      'Authorization',
      'authorisation',
      'cookie',
      'Cookie',
      'set-cookie',
      'setCookie',
      'credentials',
      'apiKey',
      'api_key',
      'x-api-key',
      'privateKey',
      'dataKey',
      'hash',
      'tokenHash',
      'signature',
      'databaseUrl',
      'DATABASE_URL',
      'SYSTEM_DATABASE_URL',
      'connectionString',
      'body',
      'rawBody',
      'key',
      'pass',
      'pwd',
      'dsn',
    ])('redacts %s', (name) => {
      expect(isRedactedName(name)).toBe(true);
      expect(redact({ [name]: 'canary-value' })).toEqual({ [name]: REDACTED });
    });

    it.each([
      'traceId',
      'method',
      'route',
      'status',
      'durationMs',
      'name',
      'keyboard',
      'monkey',
      'id',
    ])('keeps %s', (name) => {
      expect(isRedactedName(name)).toBe(false);
      expect(redact({ [name]: 'value' })).toEqual({ [name]: 'value' });
    });

    it('redacts whatever the value is', () => {
      expect(
        redact({
          password: { nested: 'canary' },
          token: ['invented-canary'],
          cookie: 12345,
          body: null,
        }),
      ).toEqual({ password: REDACTED, token: REDACTED, cookie: REDACTED, body: REDACTED });
    });

    it('redacts at any depth and inside arrays', () => {
      const entry = {
        req: {
          headers: {
            cookie: 'session=canary',
            authorization: 'Bearer canary',
            accept: 'text/plain',
          },
        },
        users: [{ email: 'mila.petrovic@example.test', passwordHash: 'canary' }],
      };
      const text = JSON.stringify(redact(entry));
      expect(text).not.toContain('canary');
      expect(text).toContain('text/plain');
    });
  });

  describe('inside text', () => {
    // The addresses are put together here, so that no credential stands in this file as
    // one piece of text (the secret scan of `pnpm check` would rightly refuse it).
    const PW = 'canary-pw';
    const address = (scheme: string, user: string, rest: string) =>
      `${scheme}://${user}:${PW}@${rest}`;

    it.each([
      [
        address('postgresql', 'confera_app', 'db.internal:5432/confera'),
        `postgresql://${REDACTED}@db.internal:5432/confera`,
      ],
      [
        `connect failed for ${address('postgres', 'u', '127.0.0.1/confera?sslmode=disable')}`,
        `connect failed for postgres://${REDACTED}@127.0.0.1/confera?sslmode=disable`,
      ],
      [
        address('smtp', 'office', 'mail.example.test:587'),
        `smtp://${REDACTED}@mail.example.test:587`,
      ],
      [address('https', 'user', 'example.test/path'), `https://${REDACTED}@example.test/path`],
      [`login failed, password=${PW}, retry`, `login failed, password=${REDACTED}, retry`],
      [`token: "${PW}" rejected`, `token=${REDACTED} rejected`],
    ])('%s', (input, expected) => {
      expect(scrubText(input)).toBe(expected);
    });

    it('leaves an address without credentials alone', () => {
      expect(scrubText('GET https://example.test/a?b=1')).toBe('GET https://example.test/a?b=1');
    });

    it('scrubs texts that sit in fields and arrays', () => {
      const out = JSON.stringify(
        redact({
          note: `dsn ${address('postgresql', 'a', 'h/db')}`,
          list: ['x', `y ${address('smtp', 'a', 'h')}`],
        }),
      );
      expect(out).not.toContain('canary-pw@h');
    });

    it('caps very long texts', () => {
      expect(scrubText('x'.repeat(10_000)).length).toBeLessThan(4100);
    });
  });

  describe('errors', () => {
    it('keeps type, message and stack, scrubbed', () => {
      const error = new Error(
        ['cannot reach postgresql://confera_app', 'canary-pw@db:5432/confera'].join(':'),
      );
      const out = redact({ err: error }) as { err: Record<string, string> };
      expect(out.err.type).toBe('Error');
      expect(out.err.message).toBe(`cannot reach postgresql://${REDACTED}@db:5432/confera`);
      expect(out.err.stack).toContain('redact.spec');
      expect(JSON.stringify(out)).not.toContain('canary-pw');
    });

    it('drops every other property of an error, such as query parameters of a driver', () => {
      const error = Object.assign(new Error('duplicate key'), {
        code: '23505',
        detail: 'Key (email)=(mila.petrovic@example.test) already exists.',
        parameters: ['mila.petrovic@example.test'],
        query: "INSERT INTO users VALUES ('canary')",
      });
      const out = redact(error) as Record<string, unknown>;
      expect(Object.keys(out).sort()).toEqual(['code', 'message', 'stack', 'type']);
      expect(JSON.stringify(out)).not.toContain('example.test');
      expect(JSON.stringify(out)).not.toContain('canary');
    });

    it('withholds the message of an error that repeats the arguments of the call', () => {
      const error = new Error(
        [
          'Invalid `prisma.user.create()` invocation:',
          "{ data: { email: 'mila.petrovic@example.test', passwordHash: 'canary' } }",
        ].join('\n'),
      );
      error.name = 'PrismaClientValidationError';
      const out = redact(error) as Record<string, string>;
      expect(out.type).toBe('PrismaClientValidationError');
      expect(JSON.stringify(out)).not.toContain('example.test');
      expect(JSON.stringify(out)).not.toContain('canary');
      expect(out.stack).toContain('redact.spec');
    });

    it('follows the cause', () => {
      const error = new Error('outer', { cause: new Error('inner password=canary-pw') });
      expect(JSON.stringify(redact(error))).not.toContain('canary-pw');
    });
  });

  describe('special values', () => {
    it('masks a Secret wherever it sits', () => {
      expect(JSON.stringify(redact({ config: { url: new Secret('canary') } }))).not.toContain(
        'canary',
      );
    });

    it('survives a circular structure', () => {
      const entry: Record<string, unknown> = { name: 'a' };
      entry.self = entry;
      expect(redact(entry)).toEqual({ name: 'a', self: '[circular]' });
    });

    it('stops at a depth limit', () => {
      let deep: Record<string, unknown> = { leaf: 'canary' };
      for (let i = 0; i < 20; i += 1) {
        deep = { next: deep };
      }
      expect(JSON.stringify(redact(deep))).not.toContain('canary');
    });

    it('does not print binary data', () => {
      expect(redact({ file: Buffer.from('canary') })).toEqual({ file: '[binary]' });
    });

    it('handles maps, sets, dates, big integers and empty values', () => {
      const date = new Date('2026-10-13T08:00:00Z');
      expect(
        redact({
          map: new Map([['token', 'canary']]),
          set: new Set(['a']),
          date,
          big: 10n,
          nothing: null,
          missing: undefined,
        }),
      ).toEqual({
        map: { token: REDACTED },
        set: ['a'],
        date,
        big: '10',
        nothing: null,
        missing: undefined,
      });
    });

    it('never changes its argument', () => {
      const entry = { password: 'invented-canary', nested: { token: 'invented-canary' } };
      redact(entry);
      expect(entry).toEqual({ password: 'invented-canary', nested: { token: 'invented-canary' } });
    });
  });
});
