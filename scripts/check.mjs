// `pnpm check`: everything that must be green before a change is handed over (ADR-01).
// Needs no database and no Docker. The tests that need the database are `pnpm test:int`.
//
// The steps run one after another and the run stops at the first failure.
import { runPnpm } from './lib/process.mjs';

const steps = [
  ['generate the Prisma client', ['run', 'prisma:generate']],
  ['formatting (prettier)', ['run', 'format:check']],
  ['lint (eslint, type-checked, with the security rules)', ['run', 'lint']],
  ['typecheck (tsc, strict)', ['run', 'typecheck']],
  ['unit and architecture tests (jest)', ['run', 'test']],
  ['production build', ['run', 'build']],
  ['development build; OpenAPI files current and schema lint', ['run', 'openapi:check']],
  ['tests of the built application (jest)', ['run', 'test:build']],
  [
    'supply chain (pins, frozen lockfile, audit, secret scan, image digests)',
    ['run', 'supply-chain'],
  ],
  // Do those checks catch what they are there for? Plants a fake secret, a vulnerable
  // package and an unlisted build script in a copy under tmp/ and expects each to be caught.
  ['supply chain catches the planted cases (ST-11)', ['run', 'test:supply-chain']],
];

const started = Date.now();
const results = [];

for (const [title, args] of steps) {
  process.stdout.write(`\n=== ${title} ===\n`);
  const stepStarted = Date.now();
  const code = await runPnpm(args);
  const seconds = ((Date.now() - stepStarted) / 1000).toFixed(1);
  results.push({ title, code, seconds });
  if (code !== 0) {
    break;
  }
}

process.stdout.write('\n=== pnpm check ===\n');
for (const { title, code, seconds } of results) {
  process.stdout.write(`  ${code === 0 ? 'ok  ' : 'FAIL'}  ${title} (${seconds} s)\n`);
}
for (const [title] of steps.slice(results.length)) {
  process.stdout.write(`  skip  ${title}\n`);
}

const failed = results.some(({ code }) => code !== 0);
const total = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(
  failed ? `\ncheck FAILED after ${total} s\n` : `\ncheck passed in ${total} s\n`,
);
process.exit(failed ? 1 : 0);
