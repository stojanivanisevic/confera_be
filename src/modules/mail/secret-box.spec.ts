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
});
