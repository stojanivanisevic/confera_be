import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';

/**
 * The box that stored secrets go into (ADR-11): AES-256-GCM under a key derived from the
 * data key of the configuration with HKDF-SHA256, which never leaves this file. Each
 * ciphertext is bound to its row and field: the additional data of the cipher is
 * `<table>:<row id>:<field>`, so a ciphertext moved to another row does not open.
 *
 * Written form: `v1:<key id>:<iv>:<tag>:<ciphertext>`, each part base64url. The key id
 * names the data key the ciphertext was made under (rotation by key id, ADR-11); 0.2.0
 * has one key, `k1`.
 */
const VERSION = 'v1';
const KEY_ID = 'k1';
const INFO = 'confera data key v1';

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

@Injectable()
export class SecretBox {
  readonly #key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.#key = Buffer.from(hkdfSync('sha256', config.dataKey.reveal(), '', INFO, 32));
  }

  /** Seals a text for one field of one row. */
  seal(plain: string, binding: { table: string; rowId: string; field: string }): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(bindingOf(binding), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      VERSION,
      KEY_ID,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  /** Opens what `seal` made for the same field of the same row. Anything else is refused. */
  open(sealed: string, binding: { table: string; rowId: string; field: string }): string {
    const [version, keyId, iv, tag, ciphertext, ...rest] = sealed.split(':');
    if (version !== VERSION || keyId !== KEY_ID || rest.length > 0 || !iv || !tag || !ciphertext) {
      throw new SecretBoxError(
        'The stored secret is not in the written form, or under another key.',
      );
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(bindingOf(binding), 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new SecretBoxError(
        'The stored secret does not open: wrong key, or moved to another row.',
      );
    }
  }
}

function bindingOf({
  table,
  rowId,
  field,
}: {
  table: string;
  rowId: string;
  field: string;
}): string {
  return `${table}:${rowId}:${field}`;
}
