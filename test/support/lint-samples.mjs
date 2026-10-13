// Lints code samples as if they were files at given paths, with the security rules only.
// Reads [{ code, filePath }] as JSON on stdin and prints, in the same order,
// [{ filePath, messages: [{ ruleId, message, fatal }] }].
// Runs in its own process because ESLint loads its configuration as an ES module,
// which Jest's module sandbox cannot do on Node 22.
import { ESLint } from 'eslint';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
}

const samples = JSON.parse(input);
const eslint = new ESLint({ overrideConfigFile: 'eslint/security-only.config.mjs' });
const results = [];
for (const { code, filePath } of samples) {
  const [result] = await eslint.lintText(code, { filePath });
  results.push({
    filePath,
    messages: (result?.messages ?? []).map(({ ruleId, message, fatal }) => ({
      ruleId,
      message,
      fatal: fatal === true,
    })),
  });
}
process.stdout.write(JSON.stringify(results));
