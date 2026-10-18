import { UNATTACHED_QUOTA_BYTES } from '../files/uploads.service';
import { clientKey, LIMITS, PublicLimits } from './public-limits';

/** Q3-03, Q3-08: who a client is, and what switches the proof-of-work on. */
describe('the limits of the public forms', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:3:4::1', '2001:db8:3:4::/64'],
    ['2001:0db8:0003:0004:ffff:ffff:ffff:ffff', '2001:db8:3:4::/64'],
    ['[2001:db8:3:4::99]', '2001:db8:3:4::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s is the client %s', (address, client) => {
    expect(clientKey(address)).toBe(client);
  });

  it('one IPv6 /64 shares one limit (Q3-03)', () => {
    const limits = new PublicLimits();
    for (let n = 1; n <= 30; n += 1) {
      expect(limits.takeToken(`2001:db8:3:4::${n.toString(16)}`)).toBe(true);
    }
    expect(limits.takeToken('2001:db8:3:4:ffff::1')).toBe(false);
    expect(limits.takeToken('2001:db8:3:5::1')).toBe(true);
  });

  it('volume alone from one address asks for no work; three acts of a script do (Q3-08)', () => {
    const limits = new PublicLimits();
    for (let n = 0; n < 30; n += 1) {
      limits.takeToken('198.51.100.1');
    }
    for (let n = 0; n < 10; n += 1) {
      limits.takeSubmit('198.51.100.1');
    }
    expect(limits.addressUnderLoad('198.51.100.1')).toBe(false);
    limits.suspicious('198.51.100.2');
    limits.suspicious('198.51.100.2');
    expect(limits.addressUnderLoad('198.51.100.2')).toBe(false);
    limits.suspicious('198.51.100.2');
    expect(limits.addressUnderLoad('198.51.100.2')).toBe(true);
  });

  it('one client keeps at most half the quota of unattached bytes of an organisation (SEC-M3-02)', () => {
    const limits = new PublicLimits();
    const cap = LIMITS.uploadBytesPerAddress.limit;
    expect(cap).toBe(UNATTACHED_QUOTA_BYTES / 2);
    expect(limits.uploadBytesLeft('2001:db8:3:4::1')).toBe(cap);
    limits.keptUploadBytes('2001:db8:3:4::1', cap - 10);
    // The same /64, another address: the same client.
    expect(limits.uploadBytesLeft('2001:db8:3:4::2')).toBe(10);
    limits.keptUploadBytes('2001:db8:3:4::2', 10);
    expect(limits.uploadBytesLeft('2001:db8:3:4::1')).toBe(0);
    expect(limits.uploadBytesLeft('2001:db8:3:5::1')).toBe(cap);
  });
});
