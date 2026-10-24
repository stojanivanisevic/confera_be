// The supply-chain checks of ADR-01 (finding SEC-A-29, test ST-11). Part of `pnpm check`.
//
//   1. every dependency is pinned to an exact version, and so is pnpm itself (with its hash);
//   2. the pnpm settings that guard installs are still in place;
//   3. the lockfile matches package.json and passes the release-age policy (frozen install);
//   4. no known vulnerability of severity high or critical (`pnpm audit`);
//   5. no secret in the files that git would take (secretlint for known formats, and the
//      scan of scripts/secret-assignments/ for literal values bound to names like a secret);
//   6. every container image is referenced by digest.
//
// Start it through pnpm: `corepack pnpm supply-chain`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, runNode, runPnpm, tool } from './lib/process.mjs';
import { formatFindings, scanDirectory } from './secret-assignments/secret-assignments.mjs';
import { SECRET_SCAN_EXCLUDE } from './secret-scan.config.mjs';

/** Shortest waiting time for a new release that this repository accepts, in minutes (one day). */
const MINIMUM_RELEASE_AGE_FLOOR = 1440;

const problems = [];
const done = [];

function fail(message) {
  problems.push(message);
}

function pnpmSetting(name) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) {
    throw new Error('Start this script through pnpm, for example: corepack pnpm supply-chain');
  }
  const text = execFileSync(process.execPath, [pnpm, 'config', 'get', '--json', name], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (text === '' || text === 'undefined') {
    return undefined;
  }
  return JSON.parse(text);
}

function checkPins() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (!exact.test(version)) {
        fail(`package.json ${field}: "${name}" is "${version}"; pin an exact version.`);
      }
    }
  }
  if (!/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/.test(manifest.packageManager ?? '')) {
    fail('package.json packageManager: pin pnpm to an exact version with its sha512 hash.');
  }
  if (typeof manifest.engines?.node !== 'string') {
    fail('package.json engines.node: state the supported Node versions.');
  }
  done.push('dependencies and pnpm are pinned to exact versions');
}

function checkSettings() {
  const age = pnpmSetting('minimumReleaseAge');
  if (typeof age !== 'number' || age < MINIMUM_RELEASE_AGE_FLOOR) {
    fail(
      `pnpm-workspace.yaml minimumReleaseAge: must be at least ${String(MINIMUM_RELEASE_AGE_FLOOR)} minutes.`,
    );
  }
  // An exception to the release age names one exact version (a security patch), never a
  // whole package or a range.
  for (const entry of pnpmSetting('minimumReleaseAgeExclude') ?? []) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+$/.test(String(entry))) {
      fail(
        `pnpm-workspace.yaml minimumReleaseAgeExclude: "${String(entry)}" must name one exact version.`,
      );
    }
  }
  if (pnpmSetting('minimumReleaseAgeStrict') === false) {
    fail('pnpm-workspace.yaml minimumReleaseAgeStrict: must not be switched off.');
  }
  if (pnpmSetting('frozenLockfile') !== true) {
    fail(
      'pnpm-workspace.yaml frozenLockfile: must be true, so that an install never changes the lockfile.',
    );
  }
  if (pnpmSetting('strictDepBuilds') === false) {
    fail(
      'pnpm-workspace.yaml strictDepBuilds: must stay on, so that an unlisted build script stops the install.',
    );
  }
  if (pnpmSetting('dangerouslyAllowAllBuilds') === true) {
    fail('pnpm-workspace.yaml dangerouslyAllowAllBuilds: must never be true.');
  }
  if (pnpmSetting('blockExoticSubdeps') === false) {
    fail('pnpm-workspace.yaml blockExoticSubdeps: must stay on.');
  }
  const allowBuilds = pnpmSetting('allowBuilds') ?? {};
  for (const [name, allowed] of Object.entries(allowBuilds)) {
    if (typeof allowed !== 'boolean') {
      fail(`pnpm-workspace.yaml allowBuilds: "${name}" must be true or false.`);
    }
  }
  const allowed = Object.entries(allowBuilds)
    .filter(([, value]) => value === true)
    .map(([name]) => name);
  done.push(
    `release age ${String(age)} min, frozen lockfile, build scripts allowed for: ${allowed.join(', ') || 'none'}`,
  );
}

function checkImageDigests() {
  const digest = /@sha256:[0-9a-f]{64}\s*$/;
  const files = readdirSync(repoRoot).filter(
    (name) => /^(docker-)?compose.*\.ya?ml$/.test(name) || /^Dockerfile/.test(name),
  );
  let images = 0;
  for (const name of files) {
    const lines = readFileSync(path.join(repoRoot, name), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const compose = /^\s*image:\s*(\S+)/.exec(line);
      const dockerfile = /^\s*FROM\s+(\S+)/i.exec(line);
      const reference = compose?.[1] ?? dockerfile?.[1];
      if (reference === undefined || reference === 'scratch') {
        return;
      }
      images += 1;
      if (!digest.test(reference.replace(/["']/g, ''))) {
        fail(
          `${name}:${String(index + 1)}: image "${reference}" must be referenced by digest (@sha256:...).`,
        );
      }
    });
  }
  done.push(`${String(images)} container image(s) referenced by digest`);
}

async function step(title, runStep, failure) {
  process.stdout.write(`\n> ${title}\n`);
  const code = await runStep();
  if (code !== 0) {
    fail(failure);
  } else {
    done.push(title);
  }
}

checkPins();
checkSettings();
checkImageDigests();

await step(
  'lockfile matches package.json and passes the install policies (frozen install)',
  () => runPnpm(['install', '--frozen-lockfile']),
  'The frozen install failed: the lockfile does not match package.json, or a locked version breaks a policy.',
);

await step(
  'no known vulnerability of severity high or critical (pnpm audit)',
  () => runPnpm(['audit', '--audit-level', 'high']),
  'pnpm audit found a vulnerability of severity high or critical.',
);

await step(
  'no secret in the files that git would take (secretlint, and literal values bound to names like a secret)',
  async () => {
    // Two scans, one verdict. secretlint knows the format of many credentials; the second
    // scan catches a secret that has no format and is given away by its name only
    // (the rule is in scripts/secret-assignments/secret-assignments.mjs and in the README).
    const formats = await runNode([tool('secretlint', 'bin', 'secretlint.js'), '**/*']);
    const assignments = scanDirectory(repoRoot, { exclude: SECRET_SCAN_EXCLUDE });
    if (assignments.length > 0) {
      process.stdout.write(`${formatFindings(repoRoot, assignments)}\n`);
    }
    return formats !== 0 || assignments.length > 0 ? 1 : 0;
  },
  'The secret scan failed: secretlint found something that looks like a secret, or a literal value is bound to a name like a secret.',
);

if (!existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) {
  fail('pnpm-lock.yaml is missing.');
}

process.stdout.write('\nSupply chain\n');
for (const line of done) {
  process.stdout.write(`  ok    ${line}\n`);
}
for (const line of problems) {
  process.stdout.write(`  FAIL  ${line}\n`);
}
process.exit(problems.length === 0 ? 0 : 1);
