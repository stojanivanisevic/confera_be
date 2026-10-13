import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION } from './version';

describe('APP_VERSION', () => {
  it('equals the version in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(APP_VERSION).toBe(manifest.version);
  });

  it('is a SemVer version', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
