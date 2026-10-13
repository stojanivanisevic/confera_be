// Everything test/architecture/lint-rules.spec.ts needs from ESLint, in ONE child process,
// because starting ESLint with typescript-eslint is the expensive part (a second or two on
// a free machine, far more while the unit tier runs on all processors of a cold clone):
//
// 1. lints code samples as if they were files at given paths, with the security rules only;
// 2. works out the REAL configuration (eslint.config.mjs) for given paths, as
//    `eslint --print-config` would, and returns the rules the test asks for.
//
// Reads { samples: [{ code, filePath }], configs: { paths: [...], rules: [...] } } as JSON
// on stdin and prints
// { results: [{ filePath, messages: [{ ruleId, message, fatal }] }], configs: { <path>: { <rule>: [...] } } }.
//
// Runs in its own process because ESLint loads its configuration as an ES module,
// which Jest's module sandbox cannot do on Node 22.
import { ESLint } from 'eslint';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
}

const { samples, configs: wanted } = JSON.parse(input);

const securityOnly = new ESLint({ overrideConfigFile: 'eslint/security-only.config.mjs' });
const results = [];
for (const { code, filePath } of samples) {
  const [result] = await securityOnly.lintText(code, { filePath });
  results.push({
    filePath,
    messages: (result?.messages ?? []).map(({ ruleId, message, fatal }) => ({
      ruleId,
      message,
      fatal: fatal === true,
    })),
  });
}

// The configuration of the repository itself, found the way `eslint .` finds it.
const real = new ESLint();
const configs = {};
for (const filePath of wanted.paths) {
  const config = await real.calculateConfigForFile(filePath);
  configs[filePath] = Object.fromEntries(
    wanted.rules.map((rule) => [rule, config?.rules?.[rule] ?? null]),
  );
}

process.stdout.write(JSON.stringify({ results, configs }));
