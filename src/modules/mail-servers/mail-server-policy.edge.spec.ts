import { isRefusedAddress, targetProblem } from './mail-server-policy';

/**
 * E2-02 (ADR-11, SEC-A-18, ST-20): "on a server a target may not be a loopback, private,
 * link-local or container-network address ... the same check runs again on every address
 * the host name resolves to". An IPv6 address has many spellings; `isRefusedAddress`
 * knows the short loopback `::1` and the dotted IPv4-mapped form, and nothing else.
 */
describe('a mail server target on a server (E2-02)', () => {
  it.each([
    ['loopback written in full', '0:0:0:0:0:0:0:1'],
    ['loopback, zero-padded', '0000:0000:0000:0000:0000:0000:0000:0001'],
    ['IPv4-mapped loopback in hex', '::ffff:7f00:1'],
    ['IPv4-mapped loopback in hex, padded', '::ffff:7f00:0001'],
    ['IPv4-mapped loopback, long', '0:0:0:0:0:ffff:7f00:1'],
    ['IPv4-mapped cloud metadata address', '::ffff:a9fe:a9fe'],
    ['IPv4-mapped private 10/8', '::ffff:0a00:0001'],
    ['IPv4-mapped private 192.168/16', '::ffff:c0a8:1'],
    ['IPv4-compatible loopback', '::7f00:1'],
    ['the unspecified address in full', '0:0:0:0:0:0:0:0'],
    ['the unspecified address, short', '::0'],
  ])('refuses %s (%s)', (_name, address) => {
    expect(isRefusedAddress(address)).toBe(true);
    expect(targetProblem({ host: `[${address}]`, port: 587, tlsMode: 'starttls' }, 'prod')).toBe(
      'address_not_allowed',
    );
  });
});
