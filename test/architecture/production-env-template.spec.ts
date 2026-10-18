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
 * key. The production compose file arrives with M4-BE-07 and gets the same test.
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

  it('lists INSTANCE and every required variable', () => {
    const required = VARIABLE_NAMES.filter((name) => VARIABLES[name].required);
    for (const name of ['INSTANCE', ...required]) {
      expect(Object.keys(active)).toContain(name);
    }
  });

  it('lists nothing the schema does not know', () => {
    for (const name of mentioned) {
      expect(VARIABLE_NAMES).toContain(name);
    }
  });

  it('holds no value for a secret, and no value for INSTANCE', () => {
    for (const name of [...SECRET_VARIABLE_NAMES, 'INSTANCE']) {
      expect(active[name]).toBe('');
    }
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

  it('is a valid server configuration once the operator has filled it in', () => {
    const result = parseEnvironment({
      ...active,
      INSTANCE: 'staging',
      ADMIN_ORIGIN: 'https://admin.confera.test',
      PUBLIC_ORIGIN: 'https://forms.confera.test',
      DATABASE_URL: 'postgresql://confera_app:invented-app@127.0.0.1:5432/confera',
      SYSTEM_DATABASE_URL: 'postgresql://confera_system:invented-system@127.0.0.1:5432/confera',
      DATA_KEY: 'invented-data-key-of-the-server-template-0123456789ab',
      FILE_STORAGE_DIR: '/var/lib/confera/files',
      CLAMAV_ADDRESS: 'clamav:3310',
      STAGING_MAIL_CATCHER: 'mailpit:1025',
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });
});
