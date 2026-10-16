import nodemailer from 'nodemailer';
import type { AppConfig } from '../../config/config';
import { type DeliveryTarget, type HostLookup, MailTransport } from './mail-transport';

/**
 * SEC-M2-13: the controls of the transport that only a lookup or the options handed to the
 * mail library can show. (1) On a server every address a name resolves to is checked, and
 * the connection goes to the checked address with the name for the certificate. (2) TLS
 * 1.2 at least, with a verified certificate.
 */
const server = { stage: 'prod' } as AppConfig;
const target: DeliveryTarget = {
  host: 'smtp.example.test',
  port: 587,
  tlsMode: 'starttls',
  username: null,
  password: null,
  fromAddress: 'office@example.test',
  fromName: 'Ured',
};
const message = { to: 'mila@example.test', subject: 'Proba', html: '<p>x</p>', text: 'x' };
const resolvingTo =
  (...addresses: string[]): HostLookup =>
  () =>
    Promise.resolve(addresses.map((address) => ({ address })));

describe('the mail transport (SEC-M2-13)', () => {
  let created: Record<string, unknown>[];

  beforeEach(() => {
    created = [];
    jest.spyOn(nodemailer, 'createTransport').mockImplementation(((
      options: Record<string, unknown>,
    ) => {
      created.push(options);
      return { sendMail: () => Promise.resolve({}), close: () => undefined };
    }) as unknown as typeof nodemailer.createTransport);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['a name that resolves to loopback', ['127.0.0.1']],
    ['a name that resolves to a mapped private address', ['::ffff:10.0.0.1']],
    ['a name that resolves to one public and one private address', ['203.0.113.10', '10.0.0.1']],
    ['a name that resolves to the cloud metadata address', ['169.254.169.254']],
  ])('refuses %s, before any connection', async (_name, addresses) => {
    const transport = new MailTransport(server, resolvingTo(...addresses));
    await expect(transport.deliver(target, message)).resolves.toEqual({
      ok: false,
      error: 'address_not_allowed',
    });
    expect(created).toEqual([]);
  });

  it('connects to the checked address, with the name for the certificate, TLS 1.2 at least, verified', async () => {
    const transport = new MailTransport(server, resolvingTo('203.0.113.10'));
    await expect(transport.deliver(target, message)).resolves.toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(
      expect.objectContaining({
        host: '203.0.113.10',
        port: 587,
        requireTLS: true,
        secure: false,
        ignoreTLS: false,
        tls: expect.objectContaining({
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
          servername: 'smtp.example.test',
        }) as unknown,
      }),
    );
  });

  it('a name that does not resolve is a failed connection, not a connection to the name', async () => {
    const transport = new MailTransport(server, () => Promise.reject(new Error('ENOTFOUND')));
    await expect(transport.deliver(target, message)).resolves.toEqual({
      ok: false,
      error: 'connection_failed',
    });
    expect(created).toEqual([]);
  });
});
