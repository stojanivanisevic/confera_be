import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvironment } from '../../src/config/config';
import { VARIABLE_NAMES } from '../../src/config/config.schema';
import { repoRoot } from '../support/run-node';

/**
 * `.env.example` is part of the contract of a fresh clone (NFR-OPS-01): copied to `.env`
 * it must give a working local configuration, and it must describe every variable.
 */
describe('.env.example', () => {
  const lines = readFileSync(join(repoRoot, '.env.example'), 'utf8').split(/\r?\n/);

  const active: Record<string, string> = {};
  const mentioned = new Set<string>();
  lines.forEach((line) => {
    const set = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    const commented = /^# ([A-Z][A-Z0-9_]*)=/.exec(line);
    if (set?.[1] !== undefined) {
      active[set[1]] = set[2] ?? '';
      mentioned.add(set[1]);
    } else if (commented?.[1] !== undefined) {
      mentioned.add(commented[1]);
    }
  });

  it.each(VARIABLE_NAMES)('describes %s', (name) => {
    expect(mentioned.has(name)).toBe(true);
  });

  it('has a comment above every variable', () => {
    lines.forEach((line, index) => {
      if (/^(# )?[A-Z][A-Z0-9_]*=/.test(line)) {
        expect({ line, previous: lines[index - 1] }).toEqual({
          line,
          previous: expect.stringMatching(/^# \S/),
        });
      }
    });
  });

  it('is a valid configuration for a developer machine as it stands', () => {
    const result = parseEnvironment(active);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.config.stage).toBe('local');
    }
  });

  it('holds placeholder passwords only', () => {
    for (const [name, value] of Object.entries(active)) {
      const password = /^postgres(?:ql)?:\/\/[^:]+:([^@]+)@/.exec(value)?.[1];
      if (password !== undefined) {
        expect({ name, password }).toEqual({
          name,
          password: expect.stringMatching(/^local-only-/),
        });
      }
    }
    expect(active.POSTGRES_PASSWORD).toMatch(/^local-only-/);
  });

  it('points every database address at the developer machine', () => {
    for (const value of Object.values(active)) {
      if (/^postgres(ql)?:\/\//.test(value)) {
        expect(new URL(value).hostname).toBe('127.0.0.1');
      }
    }
  });
});
