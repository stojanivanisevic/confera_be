// Lint rules with a security purpose (ADR-01, ADR-05, ADR-24; tests ST-09 and ST-65).
// They are syntactic, so they need no type information; eslint.config.mjs applies them
// to every file, and test/architecture/lint-rules.spec.ts proves that each one fires.

const ENV_MESSAGE =
  'Only src/config may read the environment (ADR-01). Inject the validated AppConfig instead.';

const RAW_QUERY_MESSAGE =
  'Unsafe raw queries are banned (ADR-05). Use the tagged templates $queryRaw`...` or $executeRaw`...`, which bind every value.';

const CORS_MESSAGE =
  'The API never grants cross-origin access (ADR-07, ADR-08): every call is same-origin.';

const STATIC_MESSAGE =
  'No static file serving (ADR-10): a stored file leaves only through the authorised endpoint.';

/** Reading the environment. Not applied inside src/config. */
export const environmentSyntax = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: ENV_MESSAGE,
  },
  {
    selector: "MemberExpression[object.name='process'][property.value='env']",
    message: ENV_MESSAGE,
  },
  {
    selector: "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
    message: ENV_MESSAGE,
  },
];

/** Applied everywhere, src/config included. */
export const alwaysBannedSyntax = [
  {
    selector: 'MemberExpression[property.name=/^.(queryRawUnsafe|executeRawUnsafe)$/]',
    message: RAW_QUERY_MESSAGE,
  },
  {
    selector: "CallExpression[callee.object.name='Prisma'][callee.property.name='raw']",
    message: RAW_QUERY_MESSAGE,
  },
  { selector: "CallExpression[callee.property.name='enableCors']", message: CORS_MESSAGE },
  { selector: "Property[key.name='cors']", message: CORS_MESSAGE },
  { selector: "CallExpression[callee.property.name='useStaticAssets']", message: STATIC_MESSAGE },
  {
    selector: "CallExpression[callee.object.name='express'][callee.property.name='static']",
    message: STATIC_MESSAGE,
  },
];

const environmentImports = [
  { name: 'node:process', importNames: ['env'], message: ENV_MESSAGE },
  { name: 'process', importNames: ['env'], message: ENV_MESSAGE },
  { name: 'dotenv', message: ENV_MESSAGE },
  { name: 'dotenv/config', message: ENV_MESSAGE },
  { name: '@nestjs/config', message: ENV_MESSAGE },
];

const alwaysBannedImports = [
  { name: 'cors', message: CORS_MESSAGE },
  { name: '@nestjs/serve-static', message: STATIC_MESSAGE },
  { name: 'serve-static', message: STATIC_MESSAGE },
];

/** Rules for application code and everything else that is not named below. */
export const securityRules = {
  'no-restricted-syntax': ['error', ...environmentSyntax, ...alwaysBannedSyntax],
  'no-restricted-imports': ['error', { paths: [...environmentImports, ...alwaysBannedImports] }],
};

/** Rules for the places that may read the environment. */
export const securityRulesWithEnvironment = {
  'no-restricted-syntax': ['error', ...alwaysBannedSyntax],
  'no-restricted-imports': ['error', { paths: [...alwaysBannedImports] }],
};

/**
 * The only files that may read the environment:
 * - src/config: the configuration module (its tests are NOT included);
 * - prisma.config.ts: configuration of the Prisma CLI, used by the migration job;
 * - scripts and the test harness: tools that start child processes.
 */
export const environmentReaders = {
  files: [
    'src/config/**/*.ts',
    'prisma.config.ts',
    'scripts/**/*.mjs',
    'test/**/*.ts',
    'test/**/*.cjs',
  ],
  ignores: ['src/config/**/*.spec.ts'],
};
