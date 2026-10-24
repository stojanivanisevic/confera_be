import nodemailer from 'nodemailer';
import type { AppConfig } from '../../config/config';
import {
  CATCHER_RECIPIENT,
  type DeliveryTarget,
  type HostLookup,
  MailTransport,
  ORIGINAL_RECIPIENT_HEADER,
  STAGING_MARK,
} from './mail-transport';

/**
 * SEC-M2-13: the controls of the transport that only a lookup or the options handed to the
 * mail library can show. (1) On a server every address a name resolves to is checked, and
 * the connection goes to the checked address with the name for the certificate. (2) TLS
 * 1.2 at least, with a verified certificate.
 */
const server = { stage: 'prod', mail: { stagingCatcher: null } } as unknown as AppConfig;
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
    ['a name that resolves to one public and one private address', ['8.8.4.4', '10.0.0.1']],
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
    const transport = new MailTransport(server, resolvingTo('8.8.4.4'));
    await expect(transport.deliver(target, message)).resolves.toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(
      expect.objectContaining({
        host: '8.8.4.4',
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
  describe('on a staging instance (ADR-27, ST-50)', () => {
    const staging = {
      stage: 'prod',
      mail: { stagingCatcher: { host: 'mailpit', port: 1025 } },
    } as unknown as AppConfig;
    const provider: DeliveryTarget = {
      ...target,
      host: 'smtp.gmail.com',
      username: 'ured@example.test',
      password: 'invented-provider-password',
    };

    it('sends to the catcher only, in clear, without the login of the configured server, and never looks the server up', async () => {
      const lookups: string[] = [];
      const transport = new MailTransport(staging, (host) => {
        lookups.push(host);
        return Promise.resolve([{ address: '8.8.4.4' }]);
      });
      const sent: Record<string, unknown>[] = [];
      jest.spyOn(nodemailer, 'createTransport').mockImplementation(((
        options: Record<string, unknown>,
      ) => {
        created.push(options);
        return {
          sendMail: (mail: Record<string, unknown>) => {
            sent.push(mail);
            return Promise.resolve({});
          },
          close: () => undefined,
        };
      }) as unknown as typeof nodemailer.createTransport);
      await expect(transport.deliver(provider, message)).resolves.toEqual({ ok: true });
      expect(lookups).toEqual([]);
      expect(created).toEqual([
        expect.objectContaining({ host: 'mailpit', port: 1025, ignoreTLS: true, auth: undefined }),
      ]);
      const [mail] = sent;
      // No address of the envelope or of the To header is the real recipient's.
      expect(mail?.envelope).toEqual({ from: target.fromAddress, to: [CATCHER_RECIPIENT] });
      expect(mail?.to).toEqual([{ name: 'mila@example.test', address: CATCHER_RECIPIENT }]);
      expect(mail?.headers).toEqual({
        'Content-Language': 'en',
        [ORIGINAL_RECIPIENT_HEADER]: 'mila@example.test',
      });
      expect(mail?.subject).toBe(`${STAGING_MARK} Proba`);
      expect(JSON.stringify(mail)).not.toContain('invented-provider-password');
      expect(transport.diverted).toBe(true);
    });

    it('UX4-03, UX4-06: sends a whole document in the language of the message, with its Reply-To', async () => {
      const transport = new MailTransport(staging, resolvingTo('8.8.4.4'));
      const sent: Record<string, unknown>[] = [];
      jest.spyOn(nodemailer, 'createTransport').mockImplementation((() => ({
        sendMail: (mail: Record<string, unknown>) => {
          sent.push(mail);
          return Promise.resolve({});
        },
        close: () => undefined,
      })) as unknown as typeof nodemailer.createTransport);
      await transport.deliver(provider, {
        to: 'mila@example.test',
        subject: 'Vaša prijava <IT27-0001>',
        html: '<p>Poštovanje,</p>',
        text: 'Poštovanje,\n',
        language: 'sr',
        replyTo: 'kancelarija@example.test',
      });
      const [mail] = sent;
      const html = String(mail?.html);
      expect(html).toMatch(/^<!DOCTYPE html>\n<html lang="sr-Latn">/);
      expect(html).toContain('<title>Vaša prijava &lt;IT27-0001&gt;</title>');
      expect(html).toContain('<p>Poštovanje,</p>');
      expect(html).toContain('max-width:600px');
      expect(mail?.headers).toEqual(expect.objectContaining({ 'Content-Language': 'sr-Latn' }));
      expect(mail?.replyTo).toEqual({ name: '', address: 'kancelarija@example.test' });
      // Without an address no Reply-To at all.
      await transport.deliver(provider, message);
      expect(sent[1]).not.toHaveProperty('replyTo');
    });

    it('still refuses a target that production would refuse', async () => {
      const transport = new MailTransport(staging, resolvingTo('8.8.4.4'));
      await expect(transport.deliver({ ...target, host: '10.0.0.5' }, message)).resolves.toEqual({
        ok: false,
        error: 'address_not_allowed',
      });
      expect(created).toEqual([]);
    });

    it('is off on a production instance', () => {
      expect(new MailTransport(server, resolvingTo('8.8.4.4')).diverted).toBe(false);
    });
  });
});
