// OpenAPI generator and drift check (ADR-19, test ST-29). Runs from the development build:
//
//   pnpm openapi:generate   writes openapi/openapi.json and openapi/openapi.public.json
//   pnpm openapi:check      fails when the code and the committed files differ,
//                           or when a response property is named like a secret
//
// The documents are built from the same application the entries start, with an invented
// configuration: no environment is read and no database is touched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../../../bootstrap';
import { parseEnvironment } from '../../../config/config';
import {
  CONTRACTS_DIRECTORY,
  PASSWORD_RULES_FILE,
  passwordRulesDocument,
} from '../contracts/password-rules-file';
import { buildDocuments, type ConferaDocuments } from './document';
import { compare, findDrift, formatDrift, OPENAPI_FILES, serialise, writeDocuments } from './files';
import { formatFindings, lintResponseSchemas } from './schema-lint';

const USAGE =
  'Usage: node generate.js (--write | --check) [--dir <folder>] [--contracts-dir <folder>]\n';

function toolingConfig() {
  const result = parseEnvironment({
    STAGE: 'local',
    ADMIN_ORIGIN: 'http://localhost:3000',
    PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    DATABASE_URL: 'postgresql://confera_app:invented-openapi@127.0.0.1:5432/confera_openapi',
    SYSTEM_DATABASE_URL:
      'postgresql://confera_system:invented-openapi@127.0.0.1:5432/confera_openapi',
  });
  if (!result.ok) {
    throw new Error('the configuration of the OpenAPI generator is not valid');
  }
  return result.config;
}

async function documentsFromCode(): Promise<ConferaDocuments> {
  const app = await createApp(toolingConfig(), { logDestination: { write: () => undefined } });
  try {
    return buildDocuments(app);
  } finally {
    await app.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check) {
    process.stderr.write(USAGE);
    return 2;
  }
  const dirIndex = argv.indexOf('--dir');
  const directory = resolve(dirIndex >= 0 ? (argv[dirIndex + 1] ?? 'openapi') : 'openapi');
  const contractsIndex = argv.indexOf('--contracts-dir');

  const documents = await documentsFromCode();

  const findings = [
    formatFindings(OPENAPI_FILES.admin, lintResponseSchemas(documents.admin)),
    formatFindings(OPENAPI_FILES.public, lintResponseSchemas(documents.public)),
  ].filter((text) => text !== '');
  if (findings.length > 0) {
    process.stderr.write(
      `OpenAPI schema lint failed: a response must not have a property named like a password, secret, token, hash or key.\n${findings.join('\n')}\n`,
    );
    return 1;
  }

  // The other contract of the API: the password rule set with its vectors (ADR-03, ST-62).
  // With --dir alone (a test's copy), the rule set is written and checked in that folder too.
  const contracts = resolve(
    contractsIndex >= 0
      ? (argv[contractsIndex + 1] ?? CONTRACTS_DIRECTORY)
      : dirIndex >= 0
        ? directory
        : CONTRACTS_DIRECTORY,
  );
  const rules = serialise(passwordRulesDocument());
  const rulesPath = join(contracts, PASSWORD_RULES_FILE);

  if (write) {
    for (const path of writeDocuments(directory, documents)) {
      process.stdout.write(`wrote ${path}\n`);
    }
    mkdirSync(contracts, { recursive: true });
    writeFileSync(rulesPath, rules, 'utf8');
    process.stdout.write(`wrote ${rulesPath}\n`);
    return 0;
  }

  const drift = findDrift(directory, documents);
  const rulesDrift = compare(
    `${CONTRACTS_DIRECTORY}/${PASSWORD_RULES_FILE}`,
    rules,
    existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : undefined,
  );
  if (rulesDrift !== undefined) {
    drift.push(rulesDrift);
  }
  if (drift.length > 0) {
    process.stderr.write(
      `OpenAPI files are stale, or the password rule set is: the code and the committed files differ.\n${formatDrift(drift)}\nRun "corepack pnpm openapi:generate", look at the diff and commit it.\n`,
    );
    return 1;
  }
  process.stdout.write(
    'OpenAPI files are current, and so is the password rule set; they pass the schema lint.\n',
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `OpenAPI generation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  },
);
