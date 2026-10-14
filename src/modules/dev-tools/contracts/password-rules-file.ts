import { ruleSet } from '../../access/password-rules';
import { PASSWORD_VECTORS } from './password-rule-vectors';

/**
 * The password rule set as a contract (ADR-03: "exported once by the API and proven equal
 * in both repositories by shared vectors"; ST-62). `pnpm openapi:generate` writes it next
 * to the OpenAPI files' contract, `pnpm openapi:check` fails when it is stale. The web
 * application vendors it and runs the vectors against its live checklist.
 */
export const CONTRACTS_DIRECTORY = 'contracts';
export const PASSWORD_RULES_FILE = 'password-rules.json';

export function passwordRulesDocument(): Record<string, unknown> {
  return {
    $comment:
      'Generated from src/modules/access/password-rules.ts by `pnpm openapi:generate`; do not edit. The four lines of the password checklist (G2-25) and the vectors both repositories must pass: for each vector, the results of the four lines.',
    ...ruleSet(),
    vectors: PASSWORD_VECTORS.map(({ name, candidate, repeat, context, met }) => ({
      name,
      candidate,
      repeat,
      context,
      met,
    })),
  };
}
