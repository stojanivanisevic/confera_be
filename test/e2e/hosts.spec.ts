import { ADMIN_HOST, type E2eApp, PUBLIC_HOST, startE2eApp } from './support/e2e-app';

/**
 * The two host names against odd `Host` headers (ADR-02, SEC-A-50, ST-66 routing part).
 *
 * The admin API answers only when the Host header IS the admin host name, with or
 * without a port. A header that merely contains that name somewhere, or that is not a
 * host at all (it has a user part, a path, a query or a fragment), is not the admin host
 * name and must be answered like a route that does not exist.
 */
describe('odd Host headers', () => {
  jest.setTimeout(120_000);

  let e2e: E2eApp;
  const ask = (host: string, path = '/api/v1/meta') => e2e.http().get(path).set('Host', host);

  beforeAll(async () => {
    e2e = await startE2eApp();
  });

  afterAll(async () => {
    await e2e.close();
  });

  describe('the admin host name itself', () => {
    it.each([
      ['as it is', ADMIN_HOST],
      ['with a port', `${ADMIN_HOST}:443`],
      ['with another port', `${ADMIN_HOST}:8443`],
      ['in upper case', ADMIN_HOST.toUpperCase()],
      ['in mixed case with a port', `Admin.Confera.TEST:3001`],
    ])('%s is answered', async (_name, host) => {
      expect((await ask(host)).status).toBe(200);
    });
  });

  describe('another host name', () => {
    it.each([
      ['the public host name', PUBLIC_HOST],
      ['an unknown name', 'evil.example'],
      ['an address', '127.0.0.1'],
      ['an address with a port', '127.0.0.1:3001'],
      ['the IPv6 loopback', '[::1]:3001'],
      ['localhost', 'localhost'],
      ['a name that ends with the admin name', `evil-${ADMIN_HOST}`],
      ['a subdomain of the admin name', `x.${ADMIN_HOST}`],
      ['a name that starts with the admin name', `${ADMIN_HOST}.evil.example`],
      ['the admin name with a trailing dot', `${ADMIN_HOST}.`],
      ['two names', `${ADMIN_HOST}, evil.example`],
      ['two names the other way', `evil.example, ${ADMIN_HOST}`],
      ['a name with a space', `admin .confera.test`],
      ['a port that is not a number', `${ADMIN_HOST}:http`],
      ['a port that is too large', `${ADMIN_HOST}:99999`],
      ['a very long name', `${'a'.repeat(4000)}.${ADMIN_HOST}`],
      ['the admin name as the user part of another host', `${ADMIN_HOST}@evil.example`],
      ['the admin name with a password part', `${ADMIN_HOST}:x@evil.example`],
    ])('%s is not found', async (_name, host) => {
      const response = await ask(host);
      expect(response.status).toBe(404);
      expect(response.body).toEqual(expect.objectContaining({ code: 'not_found', status: 404 }));
    });

    it('headers that a client can add do not change the host', async () => {
      const response = await ask(PUBLIC_HOST)
        .set('X-Forwarded-Host', ADMIN_HOST)
        .set('X-Forwarded-Server', ADMIN_HOST)
        .set('X-Host', ADMIN_HOST)
        .set('X-Original-Host', ADMIN_HOST)
        .set('X-HTTP-Host-Override', ADMIN_HOST)
        .set('Forwarded', `host=${ADMIN_HOST};proto=https`)
        .set('Origin', `https://${ADMIN_HOST}`)
        .set('Referer', `https://${ADMIN_HOST}/`);
      expect(response.status).toBe(404);
    });
  });

  describe('a header that is not a host name at all', () => {
    // A Host header is `name` or `name:port` (RFC 9110, section 7.2). Each of these has
    // the admin host name in it and something a host name never has. The application
    // must not read the admin name out of them.
    it.each([
      ['a user part before the admin name', `evil.example@${ADMIN_HOST}`],
      ['a user and a password before the admin name', `user:pw@${ADMIN_HOST}`],
      ['a path after the admin name', `${ADMIN_HOST}/evil.example`],
      ['a query after the admin name', `${ADMIN_HOST}?evil.example`],
      ['a fragment after the admin name', `${ADMIN_HOST}#evil.example`],
      ['a backslash after the admin name', `${ADMIN_HOST}\\evil.example`],
      ['a percent-encoded letter in the admin name', ADMIN_HOST.replace('a', '%61')],
    ])('%s is not found', async (_name, host) => {
      const response = await ask(host);
      expect(response.status).toBe(404);
    });
  });

  describe('the public host name', () => {
    it('does not open the admin API through an odd header either', async () => {
      for (const host of [`${PUBLIC_HOST}@${ADMIN_HOST}.evil.example`, `${PUBLIC_HOST}:443`]) {
        expect((await ask(host)).status).toBe(404);
      }
    });
  });
});
