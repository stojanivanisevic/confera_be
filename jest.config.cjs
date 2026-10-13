// Jest configuration (ADR-24). Three tiers, each a Jest project:
//
//   unit          src/**/*.spec.ts and test/architecture   no build, no Docker
//   build         test/build                               needs `pnpm build`
//   integration   test/integration                         needs the Docker database
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
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/dist-dev/'],
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/architecture/**/*.spec.ts'],
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
    },
  ],
};
