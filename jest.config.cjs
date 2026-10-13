// Jest configuration (ADR-24). Four tiers, each a Jest project:
//
//   unit          src/**/*.spec.ts, test/architecture,     no build, no Docker
//                 test/tooling and test/qa
//   build         test/build                               needs `pnpm build`
//   integration   test/integration                         needs the Docker database
//   e2e           test/e2e                                 needs the Docker stack
//
// NestJS 12 is published as ES modules only. Jest can `require()` those natively on
// Node 24.9 and later; on Node 22 (ADR-01) the packages listed in `esmOnlyPackages` are
// turned into CommonJS for the test run by test/support/esm-dependency-transformer.cjs.
const esmOnlyPackages = ['@nestjs/'];

const base = {
  testEnvironment: 'node',
  rootDir: __dirname,
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
    '^.+\\.m?js$': '<rootDir>/test/support/esm-dependency-transformer.cjs',
  },
  // Written with forward slashes: Jest converts them on Windows.
  transformIgnorePatterns: [`/node_modules/(?!\\.pnpm/)(?!(?:${esmOnlyPackages.join('|')}))`],
  // tmp/ holds tool output and, while `pnpm test:supply-chain` runs, a copy of the repository.
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/dist-dev/', '<rootDir>/tmp/'],
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: [
        '<rootDir>/src/**/*.spec.ts',
        '<rootDir>/test/architecture/**/*.spec.ts',
        '<rootDir>/test/tooling/**/*.spec.ts',
        '<rootDir>/test/qa/**/*.spec.ts',
      ],
    },
    {
      ...base,
      displayName: 'build',
      testMatch: ['<rootDir>/test/build/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      // Creates the test database with db:provision and prisma migrate deploy.
      globalSetup: '<rootDir>/test/integration/support/global-setup.ts',
    },
    {
      ...base,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.spec.ts'],
      // Creates the e2e database with db:provision and prisma migrate deploy.
      globalSetup: '<rootDir>/test/e2e/support/global-setup.ts',
    },
  ],
};
