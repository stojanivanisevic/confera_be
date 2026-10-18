import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvironment } from '../../src/config/config';
import {
  DEV_PREFIX,
  SECRET_VARIABLE_NAMES,
  VARIABLE_NAMES,
  VARIABLES,
} from '../../src/config/config.schema';
import { TOOL_ONLY_VARIABLES } from '../../src/config/stage-guard';
import { repoRoot } from '../support/run-node';

/**
 * ST-04 (govcore matrix, row 3): the environment template of a server holds no `DEV_*`
 * key. Since M4-BE-07 the secrets are not in it at all: each is a file of its own that
 * deploy/compose.yml gives to the API and the worker (production-compose.spec.ts), and the
 * compose file sets what the topology fixes (INSTANCE, PORT, LISTEN_HOST, FILE_STORAGE_DIR,
 * CLAMAV_ADDRESS). deploy/checks/topology.mjs starts the real images with it.
 */
describe('deploy/api.env.example, the environment template of a server', () => {
  const text = readFileSync(join(repoRoot, 'deploy', 'api.env.example'), 'utf8');
  const lines = text.split(/\r?\n/);

  const active: Record<string, string> = {};
  const mentioned = new Set<string>();
  for (const line of lines) {
    const match = /^(# )?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[2] !== undefined) {
      mentioned.add(match[2]);
      if (match[1] === undefined) {
        active[match[2]] = match[3] ?? '';
      }
    }
  }

  it('holds no DEV_ key, not even commented out', () => {
    expect(text).not.toContain(DEV_PREFIX);
    expect([...mentioned].filter((name) => name.startsWith(DEV_PREFIX))).toEqual([]);
  });

  it('holds no credential of the migration or provisioning job', () => {
    for (const name of TOOL_ONLY_VARIABLES) {
      expect(text).not.toContain(name);
    }
  });

  it('runs the production stage', () => {
    expect(active.STAGE).toBe('prod');
  });

  it('lists every required variable that is not a secret', () => {
    const required = VARIABLE_NAMES.filter(
      (name) => VARIABLES[name].required && !VARIABLES[name].secret,
    );
    for (const name of required) {
      expect(Object.keys(active)).toContain(name);
    }
  });

  it('names no secret variable at all: the secrets are files (ADR-26)', () => {
    for (const name of SECRET_VARIABLE_NAMES) {
      expect([...mentioned]).not.toContain(name);
    }
  });

  it('lists nothing the schema does not know', () => {
    for (const name of mentioned) {
      expect(VARIABLE_NAMES).toContain(name);
    }
  });

  it('leaves INSTANCE to the compose file, and the origins empty', () => {
    expect(active.INSTANCE).toBeUndefined();
    expect(active.ADMIN_ORIGIN).toBe('');
    expect(active.PUBLIC_ORIGIN).toBe('');
  });

  it('does not start as it stands: an empty INSTANCE and empty secrets are refused', () => {
    const result = parseEnvironment(active);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.variable)).toEqual(
        expect.arrayContaining(['INSTANCE', ...SECRET_VARIABLE_NAMES]),
      );
    }
  });

  it('is a valid server configuration with the compose file and the secret files', () => {
    const result = parseEnvironment({
      ...active,
      ADMIN_ORIGIN: 'https://admin.confera.test',
      PUBLIC_ORIGIN: 'https://forms.confera.test',
      // deploy/compose.yml
      INSTANCE: 'staging',
      PORT: '3001',
      LISTEN_HOST: '0.0.0.0',
      // the secret files, read by deploy/image/entrypoint.sh
      DATABASE_URL: 'postgresql://confera_app:invented-app@127.0.0.1:5432/confera',
      SYSTEM_DATABASE_URL: 'postgresql://confera_system:invented-system@127.0.0.1:5432/confera',
      DATA_KEY: 'invented-data-key-of-the-server-template-0123456789ab',
      // deploy/compose.yml
      FILE_STORAGE_DIR: '/var/lib/confera/files',
      CLAMAV_ADDRESS: 'clamav:3310',
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });
});
