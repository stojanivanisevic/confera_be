import { parseEnvironment } from '../../src/config/config';
import {
  validEnvironment,
  validProductionEnvironment,
} from '../../src/config/testing/valid-environment';
import { type DeliveryTarget, MailTransport } from '../../src/modules/mail/mail-transport';
import { type FakeSmtp, startPlainSmtp, startSelfSignedSmtp } from '../support/fake-smtp';

/**
 * ST-20 and ST-23 against real sockets: a server without TLS and a server with a
 * self-signed certificate are refused; one message has exactly one envelope recipient;
 * on a server stage a loopback target is refused before any connection.
 */
function transportOn(env: Record<string, string | undefined>): MailTransport {
  const parsed = parseEnvironment(env);
  if (!parsed.ok) {
    throw new Error('invalid test environment');
  }
  return new MailTransport(parsed.config);
}

const message = {
  to: 'mila.petrovic@example.test',
  subject: 'Đorđe Šćepanović, Čačak, Žabalj',
  html: '<p>Đorđe Šćepanović, Čačak, Žabalj</p>',
  text: 'Đorđe Šćepanović, Čačak, Žabalj\n',
};

function target(
  port: number,
  tlsMode: DeliveryTarget['tlsMode'],
  host = '127.0.0.1',
): DeliveryTarget {
  return {
    host,
    port,
    tlsMode,
    username: null,
    password: null,
    fromAddress: 'office@example.test',
    fromName: 'Udruženje\r\nBcc: x@example.test',
  };
}

describe('the mail transport (ST-20, ST-23)', () => {
  jest.setTimeout(60_000);

  const developer = transportOn(validEnvironment());
  const server = transportOn(validProductionEnvironment());
  let plain: FakeSmtp;
  let selfSigned: FakeSmtp;

  beforeAll(async () => {
    plain = await startPlainSmtp();
    selfSigned = await startSelfSignedSmtp();
  });

  afterAll(async () => {
    await plain.close();
    await selfSigned.close();
  });

  it('refuses a server that offers no TLS when TLS is required (starttls)', async () => {
    const before = plain.sessions.length;
    await expect(developer.deliver(target(plain.port, 'starttls'), message)).resolves.toEqual({
      ok: false,
      error: 'tls_required',
    });
    const sessions = plain.sessions.slice(before);
    // Nothing of the message reached the server.
    expect(
      sessions.every((session) => session.recipients.length === 0 && session.data === ''),
    ).toBe(true);
  });

  it('refuses a server with a self-signed certificate (implicit TLS)', async () => {
    await expect(
      developer.deliver(target(selfSigned.port, 'implicit', 'localhost'), message),
    ).resolves.toEqual({ ok: false, error: 'certificate_refused' });
    expect(selfSigned.sessions.every((session) => session.data === '')).toBe(true);
  });

  it('sends in clear only where the stage allows it (the mail catcher), with one envelope recipient', async () => {
    const before = plain.sessions.length;
    await expect(developer.deliver(target(plain.port, 'none'), message)).resolves.toEqual({
      ok: true,
    });
    const [session] = plain.sessions.slice(before);
    expect(session?.recipients).toEqual(['mila.petrovic@example.test']);
    expect(
      session?.commands.filter((command) => command.toUpperCase().startsWith('RCPT')),
    ).toHaveLength(1);
    // The sender name lost its line break: no header of its own was made from it.
    expect(session?.data).not.toMatch(/^Bcc:/im);
  });

  it('refuses, on a server stage, a target without TLS and a loopback target, before connecting', async () => {
    const before = plain.sessions.length;
    await expect(server.deliver(target(plain.port, 'none'), message)).resolves.toEqual({
      ok: false,
      error: 'tls_required',
    });
    await expect(server.deliver(target(587, 'starttls'), message)).resolves.toEqual({
      ok: false,
      error: 'address_not_allowed',
    });
    await expect(server.deliver(target(587, 'starttls', 'localhost'), message)).resolves.toEqual({
      ok: false,
      error: 'address_not_allowed',
    });
    await expect(
      server.deliver(target(plain.port, 'starttls', 'smtp.example.test'), message),
    ).resolves.toEqual({
      ok: false,
      error: 'port_not_allowed',
    });
    expect(plain.sessions.length).toBe(before);
  });
});
