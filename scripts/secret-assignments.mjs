// Reports literal values assigned to names like a secret (see scripts/lib/secret-assignments.mjs).
// `pnpm supply-chain` runs it as part of the secret scan; on its own:
//
//   node scripts/secret-assignments.mjs [directory]
import path from 'node:path';
import { repoRoot } from './lib/process.mjs';
import { formatFindings, scanDirectory } from './lib/secret-assignments.mjs';

const root = path.resolve(process.argv[2] ?? repoRoot);
const findings = scanDirectory(root);
if (findings.length > 0) {
  process.stdout.write(`${formatFindings(root, findings)}\n\n`);
  process.stdout.write(`${String(findings.length)} value(s) assigned to a name like a secret.\n`);
  process.exit(1);
}
