// The security rules alone, without type information.
// Used by test/architecture/lint-rules.spec.ts to lint small code samples as if they were
// files at a given path. The real configuration (eslint.config.mjs) applies the very same
// rule objects; the test also checks that.
import tseslint from 'typescript-eslint';
import {
  environmentReaders,
  securityRules,
  securityRulesWithEnvironment,
} from './security-rules.mjs';

export default [
  { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
  { rules: securityRules },
  { ...environmentReaders, rules: securityRulesWithEnvironment },
];
