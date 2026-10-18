import { configFrom } from '../../common/testing/test-app';
import { validEnvironment } from '../../config/testing/valid-environment';
import { SecretBox, SecretBoxError } from './secret-box';

describe('the secret box (ADR-11)', () => {
  const box = new SecretBox(configFrom(validEnvironment()));
  const binding = { table: 'mail_servers', rowId: 'a1', field: 'password' };

  it('seals and opens a text under the data key, bound to its row and field', () => {
    const sealed = box.seal('invented-mail-password', binding);
    expect(sealed).toMatch(/^v1:k1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('invented');
    expect(box.open(sealed, binding)).toBe('invented-mail-password');
    expect(box.seal('invented-mail-password', binding)).not.toBe(sealed);
  });

  it('a ciphertext moved to another row or field, or made under another key, does not open', () => {
    const sealed = box.seal('invented-mail-password', binding);
    for (const other of [
      { ...binding, rowId: 'b2' },
      { ...binding, field: 'username' },
      { ...binding, table: 'users' },
    ]) {
      expect(() => box.open(sealed, other)).toThrow(SecretBoxError);
    }
    const otherBox = new SecretBox(
      configFrom(
        validEnvironment({ DATA_KEY: 'invented-another-key-of-the-unit-tests-0123456789' }),
      ),
    );
    expect(() => otherBox.open(sealed, binding)).toThrow(SecretBoxError);
    expect(() => box.open('v1:k2:a:b:c', binding)).toThrow(SecretBoxError);
    expect(() => box.open('plain text', binding)).toThrow(SecretBoxError);
  });

  it('opens nothing with a tag cut short, however few bytes are missing (M2-ISS-20, SEC-M2-11)', () => {
    const [version, keyId, iv, tag, ciphertext] = box
      .seal('invented-mail-password', binding)
      .split(':');
    const full = Buffer.from(tag ?? '', 'base64url');
    expect(full).toHaveLength(16);
    for (const length of [4, 8, 12, 15]) {
      const cut = full.subarray(0, length).toString('base64url');
      expect(() => box.open([version, keyId, iv, cut, ciphertext].join(':'), binding)).toThrow(
        SecretBoxError,
      );
    }
  });
});
