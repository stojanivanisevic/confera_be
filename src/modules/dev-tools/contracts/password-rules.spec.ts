import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPassword, PASSWORD_RULE_IDS } from '../../access/password-rules';
import { serialise } from '../openapi/files';
import {
  CONTRACTS_DIRECTORY,
  PASSWORD_RULES_FILE,
  passwordRulesDocument,
} from './password-rules-file';
import { PASSWORD_VECTORS } from './password-rule-vectors';

/**
 * ST-62: the password rule set and its shared vectors (ADR-03, G2-25, FR-USR-06). The
 * server's rules give, for every vector, the four results written in it; the web
 * application runs the same vectors from contracts/password-rules.json against its live
 * checklist.
 */
const repoRoot = join(__dirname, '..', '..', '..', '..');

describe('the password rule set and its vectors (ST-62)', () => {
  it.each(PASSWORD_VECTORS.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, { candidate, repeat, context, met }) => {
      const results = Object.fromEntries(
        checkPassword(candidate, repeat, context).map(({ id, met: result }) => [id, result]),
      );
      expect(results).toEqual(met);
    },
  );

  it('the vectors show every line met and every line not met', () => {
    for (const id of PASSWORD_RULE_IDS) {
      expect(PASSWORD_VECTORS.some((vector) => vector.met[id])).toBe(true);
      expect(PASSWORD_VECTORS.some((vector) => !vector.met[id])).toBe(true);
    }
    expect(PASSWORD_VECTORS.length).toBeGreaterThanOrEqual(30);
  });

  it('every person of the vectors is invented and lives on example.test', () => {
    for (const { context } of PASSWORD_VECTORS) {
      if (context.email !== undefined) {
        expect(context.email).toMatch(/@([a-z0-9-]+\.)*example\.test$/);
      }
    }
  });

  it('the committed contract is the rule set of the code, with these vectors', () => {
    const committed = readFileSync(
      join(repoRoot, CONTRACTS_DIRECTORY, PASSWORD_RULES_FILE),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(committed).toBe(serialise(passwordRulesDocument()));
  });
});
