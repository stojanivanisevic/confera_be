import {
  chooseServers,
  isHostName,
  isRefusedAddress,
  MAIL_PORTS,
  type SelectableServer,
  targetProblem,
} from './mail-server-policy';

/** The rules of ADR-11 for a mail server's target (ST-20) and the order of FR-SMTP-02. */
describe('mail server policy', () => {
  describe('the selection order (FR-SMTP-02)', () => {
    const server = (id: string, mark: Partial<SelectableServer> = {}): SelectableServer => ({
      id,
      enabled: true,
      isDefault: false,
      isFallback: false,
      ...mark,
    });
    const servers = [
      server('default', { isDefault: true }),
      server('fallback', { isFallback: true }),
      server('conference'),
      server('template'),
      server('off', { enabled: false }),
    ];
    const ids = (chosen: SelectableServer[]) => chosen.map(({ id }) => id);

    it('takes the template server first, then the fallback', () => {
      expect(
        ids(
          chooseServers(servers, {
            templateServerId: 'template',
            conferenceServerId: 'conference',
          }),
        ),
      ).toEqual(['template', 'fallback']);
    });

    it('takes the conference server when the template sets none', () => {
      expect(
        ids(chooseServers(servers, { templateServerId: null, conferenceServerId: 'conference' })),
      ).toEqual(['conference', 'fallback']);
    });

    it("takes the organisation's default when neither sets one", () => {
      expect(ids(chooseServers(servers, {}))).toEqual(['default', 'fallback']);
    });

    it('passes over a server that is switched off, at its level', () => {
      expect(
        ids(chooseServers(servers, { templateServerId: 'off', conferenceServerId: 'conference' })),
      ).toEqual(['conference', 'fallback']);
      expect(ids(chooseServers(servers, { templateServerId: 'off' }))).toEqual([
        'default',
        'fallback',
      ]);
    });

    it('passes over a server of an unknown id', () => {
      expect(ids(chooseServers(servers, { templateServerId: 'gone' }))).toEqual([
        'default',
        'fallback',
      ]);
    });

    it('does not try the fallback twice when it was chosen', () => {
      expect(ids(chooseServers(servers, { templateServerId: 'fallback' }))).toEqual(['fallback']);
    });

    it('takes the fallback alone when there is no default', () => {
      expect(ids(chooseServers([server('fallback', { isFallback: true })], {}))).toEqual([
        'fallback',
      ]);
    });

    it('is empty when nothing is configured', () => {
      expect(chooseServers([], {})).toEqual([]);
      expect(chooseServers([server('off', { enabled: false, isDefault: true })], {})).toEqual([]);
    });
  });

  describe('the target of a server (ST-20)', () => {
    const target = (
      host: string,
      port = 587,
      tlsMode: 'implicit' | 'starttls' | 'none' = 'starttls',
    ) => ({ host, port, tlsMode });

    it('refuses a server without TLS on a server stage, and allows it on a developer machine', () => {
      expect(targetProblem(target('smtp.example.test', 587, 'none'), 'prod')).toBe('tls_required');
      expect(targetProblem(target('127.0.0.1', 1025, 'none'), 'local')).toBeNull();
      expect(targetProblem(target('127.0.0.1', 1025, 'none'), 'test')).toBeNull();
    });

    it.each([
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.17.0.2',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '[::1]',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      'localhost',
      'LOCALHOST',
      'db',
      'mailpit',
      'host.docker.internal',
      'service.internal',
      'printer.local',
    ])('refuses %s in production', (host) => {
      expect(targetProblem(target(host), 'prod')).toBe('address_not_allowed');
    });

    it.each(['smtp.example.test', '203.0.113.10', 'mail.udekom.example.test'])(
      'allows %s in production',
      (host) => {
        expect(targetProblem(target(host), 'prod')).toBeNull();
      },
    );

    it('allows the mail ports only in production', () => {
      for (const port of MAIL_PORTS) {
        expect(targetProblem(target('smtp.example.test', port), 'prod')).toBeNull();
      }
      for (const port of [22, 80, 443, 5432, 6379, 8025, 1025]) {
        expect(targetProblem(target('smtp.example.test', port), 'prod')).toBe('port_not_allowed');
      }
      expect(targetProblem(target('127.0.0.1', 1025), 'local')).toBeNull();
    });

    it('knows the refused address ranges', () => {
      expect(isRefusedAddress('8.8.8.8')).toBe(false);
      expect(isRefusedAddress('2001:db8::1')).toBe(false);
      expect(isRefusedAddress('172.15.0.1')).toBe(false);
      expect(isRefusedAddress('172.32.0.1')).toBe(false);
      expect(isRefusedAddress('224.0.0.1')).toBe(true);
      expect(isRefusedAddress('not an address')).toBe(true);
    });

    it('takes a host name without a user part, a port or a path', () => {
      expect(isHostName('smtp.example.test')).toBe(true);
      expect(isHostName('203.0.113.10')).toBe(true);
      expect(isHostName('[2001:db8::1]')).toBe(true);
      for (const value of [
        'user@smtp.example.test',
        'smtp.example.test:25',
        'smtp.example.test/x',
        'smtp example',
        '-smtp.example.test',
        '',
      ]) {
        expect(isHostName(value)).toBe(false);
      }
    });
  });
});
