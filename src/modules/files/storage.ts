import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';

/**
 * The private file storage (ADR-10): a folder on its own volume, behind this interface, so
 * that another backend (S3) can take its place later. No route serves it; the only way to a
 * file is the endpoint that decides by its owner and kind (FilesService.download).
 *
 * A storage key is `org/<organisation>/<uuid>`: it never holds anything the client sent, so
 * no file name can lead outside the root. Every path is checked to stay inside it anyway.
 */
export const STORAGE_KEY = /^org\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

export class StorageKeyError extends Error {
  constructor() {
    super('A storage key outside the storage root was refused.');
    this.name = 'StorageKeyError';
  }
}

@Injectable()
export class FileStorage {
  readonly #root: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.#root = resolve(config.files.storageDirectory);
  }

  /** A new key in the folder of an organisation. */
  newKey(organisationId: string): string {
    return `org/${organisationId.toLowerCase()}/${randomUUID()}`;
  }

  /** The path of a key, inside the root, or a refusal. */
  pathOf(key: string): string {
    if (!STORAGE_KEY.test(key)) {
      throw new StorageKeyError();
    }
    const path = resolve(this.#root, ...key.split('/'));
    const inside = relative(this.#root, path);
    if (inside === '' || inside.startsWith('..') || inside.includes(`..${sep}`)) {
      throw new StorageKeyError();
    }
    return path;
  }

  /** A file of its own for an upload in progress, in the root, never under a client's name. */
  async temporaryPath(): Promise<string> {
    const folder = join(this.#root, 'incoming');
    await mkdir(folder, { recursive: true });
    return join(folder, `${randomUUID()}.part`);
  }

  /** Moves a finished upload under its key. */
  async keep(temporary: string, key: string): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await rename(temporary, path);
  }

  read(key: string): ReadStream {
    return createReadStream(this.pathOf(key));
  }

  writeStream(path: string) {
    return createWriteStream(path, { flags: 'wx' });
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathOf(key))).size;
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async removeTemporary(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  /** The bytes of the uploads still on their way: they count against the quota (Q3-05). */
  async incomingBytes(): Promise<number> {
    let total = 0;
    for (const entry of await this.incoming()) {
      total += entry.size;
    }
    return total;
  }

  /**
   * Removes the temporary files of uploads that stopped longer ago than `olderThanMs` (a
   * process that ended in the middle of one, Q3-05). Returns how many it removed.
   */
  async removeStaleIncoming(olderThanMs: number, now = Date.now()): Promise<number> {
    let removed = 0;
    for (const entry of await this.incoming()) {
      if (now - entry.modified > olderThanMs) {
        await rm(entry.path, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private async incoming(): Promise<{ path: string; size: number; modified: number }[]> {
    const folder = join(this.#root, 'incoming');
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return [];
    }
    const entries: { path: string; size: number; modified: number }[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.part'))) {
      try {
        const info = await stat(join(folder, name));
        entries.push({ path: join(folder, name), size: info.size, modified: info.mtimeMs });
      } catch {
        // Gone in the meantime: nothing to count.
      }
    }
    return entries;
  }
}
