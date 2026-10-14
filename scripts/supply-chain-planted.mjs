// `pnpm test:supply-chain`: do the supply-chain checks catch what they are there for?
// (ST-11, M1-QA-01, ADR-01.) Part of `pnpm check`.
//
// The checks of scripts/supply-chain.mjs and the install settings of pnpm-workspace.yaml
// are only worth something if they fail when they should. This script PLANTS what they
// must catch and expects each check to fail, for the right reason and for no other:
//
//   1. a fake secret in a file that git would take         -> the secret scan fails
//   2. a package version with a known vulnerability        -> the audit fails
//   3. a dependency with a build script that is not listed -> the install stops, and the
//                                                             script does not run
//   4. package.json changed without the lockfile           -> the frozen install stops
//   5. a version range, an image without a digest,
//      a weakened install setting                          -> each is named
//
// NOTHING IS PLANTED IN THE WORKING TREE. Everything happens in a copy of the files git
// would take, under tmp/ (ignored by git), which is removed at the end, also on failure.
// Every fake secret is made of random characters at run time: none exists in this file,
// none is valid anywhere, and none outlives the run.
//
// Needs the network (the registry, for the audit), like `pnpm supply-chain` itself.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/process.mjs';

/** An old version of a well-known package with published advisories of severity high. */
const VULNERABLE = { name: 'lodash', version: '4.17.20' };

const pnpm = process.env.npm_execpath;
if (!pnpm) {
  process.stderr.write(
    'Start this script through pnpm, for example: corepack pnpm test:supply-chain\n',
  );
  process.exit(2);
}

const started = Date.now();
const results = [];

function record(title, problems, seconds) {
  results.push({ title, problems, seconds });
  process.stdout.write(
    problems.length === 0
      ? `  caught   ${title} (${seconds} s)\n`
      : `  MISSED   ${title} (${seconds} s)\n${problems.map((line) => `             ${line}\n`).join('')}`,
  );
}

async function testCase(title, run) {
  const caseStarted = Date.now();
  const problems = [];
  try {
    await run((problem) => problems.push(problem));
  } catch (error) {
    problems.push(`the case itself failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  record(title, problems, ((Date.now() - caseStarted) / 1000).toFixed(1));
}

/** Runs pnpm in a directory and returns its exit code and everything it printed. */
function pnpmIn(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [pnpm, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * Runs the real scripts/supply-chain.mjs of the copy. Started with Node directly and not
 * as `pnpm run supply-chain`: pnpm would refuse to run a script while package.json and
 * node_modules disagree (verifyDepsBeforeRun), and some cases plant exactly that.
 */
function supplyChainIn(cwd) {
  const result = spawnSync(process.execPath, [path.join('scripts', 'supply-chain.mjs')], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** The summary lines of scripts/supply-chain.mjs: which checks were ok and which failed. */
function summary(output) {
  const lines = output.split(/\r?\n/);
  return {
    ok: lines.filter((line) => /^ {2}ok {4}/.test(line)).map((line) => line.slice(8)),
    failed: lines.filter((line) => /^ {2}FAIL {2}/.test(line)).map((line) => line.slice(8)),
  };
}

function random(length, alphabet) {
  const bytes = randomBytes(length);
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += alphabet[bytes[index] % alphabet.length];
  }
  return text;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A database address, built from its parts so that this file never holds one. */
function address(role, password, host, database) {
  return ['postgresql', '://', role, ':', password, '@', host, '/', database].join('');
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

const tmpRoot = path.join(repoRoot, 'tmp');
mkdirSync(tmpRoot, { recursive: true });
// A run that was killed may have left its copy behind.
for (const name of readdirSync(tmpRoot)) {
  if (name.startsWith('planted-')) {
    rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
  }
}
const workRoot = mkdtempSync(path.join(tmpRoot, 'planted-'));
const copy = path.join(workRoot, 'repo');

function cleanUp() {
  rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanUp();
    process.exit(130);
  });
}

function copyRepository() {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const files = listed.split('\0').filter((file) => file !== '');
  for (const file of files) {
    const source = path.join(repoRoot, file);
    if (!existsSync(source)) {
      continue; // deleted in the working tree, not yet in the index
    }
    const target = path.join(copy, file);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
  }
  return files.length;
}

function plant(root, file, text) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

async function frozenLockfile() {
  await testCase(
    'package.json changed without the lockfile: the install stops and rewrites nothing',
    (miss) => {
      const manifestFile = path.join(copy, 'package.json');
      const lockFile = path.join(copy, 'pnpm-lock.yaml');
      const original = readFileSync(manifestFile, 'utf8');
      const lockBefore = sha256(lockFile);
      const manifest = JSON.parse(original);
      // A real version of the same package, other than the locked one.
      manifest.dependencies.rxjs = '7.8.1';
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      try {
        const install = pnpmIn(copy, ['install']);
        if (install.status === 0) {
          miss('`pnpm install` succeeded although package.json and the lockfile disagree');
        }
        if (!/ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile/i.test(install.output)) {
          miss('the install did not say that the lockfile is out of date');
        }
        if (sha256(lockFile) !== lockBefore) {
          miss('the install rewrote pnpm-lock.yaml');
        }
      } finally {
        writeFileSync(manifestFile, original);
      }
    },
  );
}

async function plantedSecrets() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  // Prefixes are written in two parts, so that this file never holds anything that
  // looks like a credential itself.
  const secrets = [
    {
      what: 'a GitHub token in source code',
      file: 'src/planted/github-token.ts',
      text: `export const token = '${'gh' + 'p_'}${random(36, ALNUM)}';\n`,
    },
    {
      what: 'an npm token in .npmrc',
      file: '.npmrc',
      text: `//registry.npmjs.org/:_authToken=${'np' + 'm_'}${random(36, ALNUM)}\n`,
    },
    {
      what: 'AWS keys in an environment file',
      file: 'deploy/planted-aws.env',
      text: `AWS_ACCESS_KEY_ID=${'AK' + 'IA'}${random(16, BASE32)}\nAWS_SECRET_ACCESS_KEY=${random(40, ALNUM)}\n`,
    },
    {
      what: 'a private key',
      file: 'deploy/planted-key.pem',
      text: privateKey,
    },
    {
      what: 'a database address with a real-looking password, in a test',
      file: 'test/planted/database.spec.ts',
      text: `export const url = '${'postgresql://confera_app'}:${random(20, ALNUM)}@db.confera.example.org:5432/confera';\n`,
    },
    {
      what: 'a database address on the loopback address whose password is not a placeholder',
      file: 'test/planted/loopback.spec.ts',
      text: `export const url = '${'postgresql://confera_app'}:${random(20, ALNUM)}@127.0.0.1:5432/confera';\n`,
    },
    {
      what: 'a web address with a user and a password, in a workflow file',
      file: '.github/workflows/planted.yml',
      text: `url: ${'https://deploy'}:${random(16, ALNUM)}@registry.example.org/confera\n`,
    },
    {
      what: 'a mail password in the environment file of a server (no known token format)',
      file: 'deploy/planted-server.env',
      text: `STAGE=prod\nSMTP_PASSWORD=${random(24, ALNUM)}\n`,
    },
    {
      what: 'a PayPal client secret and a data key in an environment file (no known token format)',
      file: 'deploy/planted-payments.env',
      text: `PAYPAL_CLIENT_SECRET=${random(80, ALNUM)}\nDATA_KEY=${randomBytes(32).toString('hex')}\n`,
    },
    // Second round: the same kind of secret, written the other ways a secret is commonly
    // written into the files of a server. None has a token format; the name gives each away.
    {
      what: 'a mail password as a list entry of a compose file (- NAME=value)',
      file: 'deploy/planted-compose.yml',
      text: `services:\n  api:\n    environment:\n      - STAGE=prod\n      - SMTP_PASSWORD=${random(24, ALNUM)}\n`,
    },
    {
      what: 'a mail password in a Dockerfile (ENV NAME=value)',
      file: 'deploy/planted.Dockerfile',
      text: `ENV STAGE=prod\nENV SMTP_PASSWORD=${random(24, ALNUM)}\n`,
    },
    {
      what: 'a generated password with a dollar sign in an environment file',
      file: 'deploy/planted-generated.env',
      text: `SMTP_PASSWORD=${random(8, ALNUM)}$${random(12, ALNUM)}\n`,
    },
    {
      what: 'a password under a lower-case key of a configuration file (password: value)',
      file: 'deploy/planted-config.yml',
      text: `smtp:\n  host: mail.example.test\n  password: ${random(24, ALNUM)}\n`,
    },
    {
      what: 'a session secret in source code, declared with a type (const name: string = value)',
      file: 'src/planted/typed-secret.ts',
      text: `export const sessionSecret: string = '${random(48, ALNUM)}';\n`,
    },
    {
      what: 'a session secret in source code, as the fallback of an environment variable (?? value)',
      file: 'src/planted/fallback-secret.ts',
      text: `export const sessionSecret = process.env.SESSION_SECRET ?? '${random(48, ALNUM)}';\n`,
    },
    // Caught today. It holds the rule that a placeholder STARTS with `invented-` or
    // `local-only-`: a rule that only looks for those words anywhere lets this one through.
    {
      what: 'a mail password that only contains the placeholder words, not at its start',
      file: 'deploy/planted-not-a-placeholder.env',
      text: `SMTP_PASSWORD=${random(6, ALNUM)}-invented-${random(6, ALNUM)}-local-only-${random(6, ALNUM)}\n`,
    },
    // Third round. The rule is written down now (README, "The rule for a secret-like name"):
    // a literal value bound to a secret-like name, in the syntaxes it lists, and no allowed
    // value but nothing, a reference and a placeholder. Each of these is inside that rule,
    // and the scan does not report it today.
    {
      what: 'contract: export with the quotes around the pair (export "NAME=value")',
      file: 'deploy/planted-export.sh',
      text: `#!/bin/sh\nexport "SMTP_PASSWORD=${random(24, ALNUM)}"\nexec node dist/main.js\n`,
    },
    {
      what: 'contract: name: value in a YAML file that has one more extension (.yml.example)',
      file: 'deploy/planted-compose.yml.example',
      text: `services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${random(24, ALNUM)}\n`,
    },
    {
      what: 'contract: "name": value in a JSON file that has one more extension (.json.example)',
      file: 'deploy/planted-settings.json.example',
      text: `{\n  "smtp": {\n    "host": "mail.example.test",\n    "password": "${random(24, ALNUM)}"\n  }\n}\n`,
    },
    {
      what: 'contract: a list of literal texts as the value, in JSON ("token": ["value"])',
      file: 'deploy/planted-list.json',
      text: `{ "token": ["${random(24, ALNUM)}"] }\n`,
    },
    {
      what: 'contract: a list of literal texts as the value, in YAML (credentials: - value)',
      file: 'deploy/planted-list.yml',
      text: `registry:\n  credentials:\n    - deploy\n    - ${random(24, ALNUM)}\n`,
    },
    {
      what: 'contract: a list of literal texts as the value, in TypeScript (const credentials = [...])',
      file: 'src/planted/list-secret.ts',
      text: `export const credentials = ['deploy', '${random(24, ALNUM)}'];\n`,
    },
    {
      what: 'contract: a literal fallback (??) inside the hole of a template text',
      file: 'src/planted/template-fallback.ts',
      text: `export const header = \`Bearer \${process.env.API_TOKEN ?? '${random(40, ALNUM)}'}\`;\n`,
    },
    {
      what: 'contract: NAME=value in a text file written in UTF-16 (what PowerShell 5 writes with >)',
      file: 'deploy/planted-utf16.env',
      text: Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`STAGE=prod\r\nSMTP_PASSWORD=${random(24, ALNUM)}\r\n`, 'utf16le'),
      ]),
    },
    {
      what: 'contract: name: value in a YAML mapping in braces that goes over several lines',
      file: 'deploy/planted-flow.yml',
      text: `smtp: {\n  host: mail.example.test, password: ${random(24, ALNUM)}\n}\n`,
    },
    {
      what: 'contract: an assignment that adds to the name (+=)',
      file: 'src/planted/compound.ts',
      text: `export let smtpPassword = '';\nsmtpPassword += '${random(24, ALNUM)}';\n`,
    },
  ];
  // Third round, the other direction: ordinary files. No literal value is bound to a name
  // in them, only references, so the rule excludes them. The scan reports them today.
  const ordinary = [
    {
      what: 'contract: a positional parameter of a shell script is a reference (PASSWORD="$1")',
      file: 'scripts/planted-arguments.sh',
      text: ['#!/bin/sh', 'PASSWORD="$1"', 'TOKEN=$2', 'export API_KEY="$@"', ''].join('\n'),
    },
    {
      what: 'contract: a value made of references only holds no literal (TOKEN="$PREFIX$SUFFIX")',
      file: 'scripts/planted-joined.sh',
      text: ['#!/bin/sh', 'TOKEN="$PREFIX$SUFFIX"', 'PASSWORD=$FIRST$SECOND', ''].join('\n'),
    },
  ];
  const placeholders = {
    file: 'test/planted/placeholders.spec.ts',
    text: [
      `export const a = '${address('confera_app', 'invented-app-password', '127.0.0.1:5432', 'confera_unit')}';`,
      `export const b = '${address('confera_owner', 'local-only-owner', 'localhost:5432', 'confera')}';`,
      '',
    ].join('\n'),
  };

  const planted = [...secrets, ...ordinary].map(({ file }) => file).concat(placeholders.file);
  const scanWithPlants = () => {
    try {
      for (const { file, text } of [...secrets, ...ordinary]) {
        plant(copy, file, text);
      }
      plant(copy, placeholders.file, placeholders.text);
      return supplyChainIn(copy);
    } finally {
      for (const file of planted) {
        rmSync(path.join(copy, file), { force: true });
      }
      for (const directory of ['src/planted', 'test/planted', '.github']) {
        rmSync(path.join(copy, directory), { recursive: true, force: true });
      }
    }
  };
  const { status, output } = scanWithPlants();
  const { failed } = summary(output);
  const named = (file) => output.replaceAll('\\', '/').includes(`/${file}`);

  await testCase('planted fake secrets: the secret scan fails `pnpm supply-chain`', (miss) => {
    if (status === 0) {
      miss('`pnpm supply-chain` passed with fake secrets in the tree');
    }
    if (!failed.some((line) => line.includes('secretlint found something'))) {
      miss('the summary does not say that the secret scan failed');
    }
    const others = failed.filter((line) => !line.includes('secretlint found something'));
    if (others.length > 0) {
      miss(`other checks failed too, so the run proves less: ${others.join(' | ')}`);
    }
  });
  for (const { what, file } of secrets) {
    await testCase(`planted fake secret: ${what}`, (miss) => {
      if (!named(file)) {
        miss(`the secret scan did not report ${file}`);
      }
    });
  }
  await testCase(
    'control: an invented placeholder on the loopback address is not reported',
    (miss) => {
      if (named(placeholders.file)) {
        miss(`the secret scan reported ${placeholders.file}, which holds placeholders only`);
      }
    },
  );
  for (const { what, file } of ordinary) {
    await testCase(`control, not reported: ${what}`, (miss) => {
      if (named(file)) {
        miss(`the secret scan reported ${file}, which holds references and no literal value`);
      }
    });
  }
}

async function weakenedRules() {
  await testCase(
    'a version range, an image without a digest and weakened install settings are each named',
    (miss) => {
      const manifestFile = path.join(copy, 'package.json');
      const settingsFile = path.join(copy, 'pnpm-workspace.yaml');
      const composeFile = path.join(copy, 'compose.planted.yml');
      const manifestBefore = readFileSync(manifestFile, 'utf8');
      const settingsBefore = readFileSync(settingsFile, 'utf8');
      const checkWithWeakenedRules = () => {
        try {
          const manifest = JSON.parse(manifestBefore);
          manifest.dependencies.zod = `^${manifest.dependencies.zod}`;
          writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
          writeFileSync(
            settingsFile,
            settingsBefore
              .replace(/^minimumReleaseAge:.*$/m, 'minimumReleaseAge: 60')
              .replace(/^strictDepBuilds:.*$/m, 'strictDepBuilds: false')
              .replace(/^blockExoticSubdeps:.*$/m, 'blockExoticSubdeps: false'),
          );
          writeFileSync(composeFile, 'services:\n  cache:\n    image: redis:7.4\n');
          return supplyChainIn(copy);
        } finally {
          writeFileSync(manifestFile, manifestBefore);
          writeFileSync(settingsFile, settingsBefore);
          rmSync(composeFile, { force: true });
        }
      };
      const { status, output } = checkWithWeakenedRules();
      const { failed } = summary(output);
      if (status === 0) {
        miss('`pnpm supply-chain` passed with weakened rules');
      }
      for (const [what, text] of [
        ['the version range', '"zod" is "^'],
        ['the short release age', 'minimumReleaseAge'],
        ['strictDepBuilds switched off', 'strictDepBuilds'],
        ['blockExoticSubdeps switched off', 'blockExoticSubdeps'],
        ['the image without a digest', 'must be referenced by digest'],
      ]) {
        if (!failed.some((line) => line.includes(text))) {
          miss(`not named: ${what}`);
        }
      }
    },
  );
}

async function vulnerablePackage() {
  await testCase(
    `a planted vulnerable package (${VULNERABLE.name}@${VULNERABLE.version}): the audit fails \`pnpm supply-chain\``,
    (miss) => {
      const manifestFile = path.join(copy, 'package.json');
      const lockFile = path.join(copy, 'pnpm-lock.yaml');
      const manifestBefore = readFileSync(manifestFile, 'utf8');
      const lockBefore = readFileSync(lockFile, 'utf8');
      try {
        // The documented way to add a dependency on purpose (README, section 11).
        const add = pnpmIn(copy, ['add', `${VULNERABLE.name}@${VULNERABLE.version}`]);
        if (add.status !== 0) {
          throw new Error(`could not plant the package:\n${add.output.slice(-600)}`);
        }
        const { status, output } = supplyChainIn(copy);
        const { failed } = summary(output);
        if (status === 0) {
          miss('`pnpm supply-chain` passed with a vulnerable package in the lockfile');
        }
        if (!failed.some((line) => line.includes('pnpm audit found a vulnerability'))) {
          miss('the summary does not say that the audit failed');
        }
        if (!output.includes(VULNERABLE.name)) {
          miss('the audit did not name the package');
        }
        const others = failed.filter((line) => !line.includes('pnpm audit found'));
        if (others.length > 0) {
          miss(`other checks failed too, so the run proves less: ${others.join(' | ')}`);
        }
      } finally {
        writeFileSync(manifestFile, manifestBefore);
        writeFileSync(lockFile, lockBefore);
      }
    },
  );
}

async function unlistedBuildScript() {
  // A project of its own with the install settings of this repository and one
  // dependency: a package whose install script leaves a marker file behind.
  const project = path.join(workRoot, 'build-script');
  const dependency = path.join(workRoot, 'planted-build-script');
  const marker = path.join(workRoot, 'BUILD-SCRIPT-RAN');
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  plant(
    dependency,
    'package.json',
    `${JSON.stringify(
      {
        name: 'planted-build-script',
        version: '1.0.0',
        scripts: { postinstall: 'node postinstall.js' },
      },
      null,
      2,
    )}\n`,
  );
  plant(
    dependency,
    'postinstall.js',
    "require('node:fs').writeFileSync(process.env.PLANTED_MARKER, 'ran');\n",
  );
  plant(dependency, 'index.js', 'module.exports = 1;\n');
  const packed = pnpmIn(dependency, ['pack']);
  const tarball = path.join(dependency, 'planted-build-script-1.0.0.tgz');

  plant(
    project,
    'package.json',
    `${JSON.stringify(
      {
        name: 'planted-project',
        version: '0.0.0',
        private: true,
        packageManager: manifest.packageManager,
        dependencies: {
          'planted-build-script': 'file:../planted-build-script/planted-build-script-1.0.0.tgz',
        },
      },
      null,
      2,
    )}
`,
  );
  // The settings under test: the real file of this repository, unchanged.
  cpSync(path.join(repoRoot, 'pnpm-workspace.yaml'), path.join(project, 'pnpm-workspace.yaml'));
  const env = { PLANTED_MARKER: marker };

  await testCase(
    'a dependency with an unlisted build script: the install stops and the script does not run',
    (miss) => {
      if (packed.status !== 0 || !existsSync(tarball)) {
        throw new Error(`could not pack the planted dependency:
${packed.output.slice(-600)}`);
      }
      // The first install of a new project writes its lockfile; the second is frozen.
      for (const [name, flag] of [
        ['the first install', '--no-frozen-lockfile'],
        ['the frozen install', '--frozen-lockfile'],
      ]) {
        const install = pnpmIn(project, ['install', flag], env);
        if (install.status === 0) {
          miss(`${name} succeeded for a dependency with an unlisted build script`);
        }
        if (!install.output.includes('ERR_PNPM_IGNORED_BUILDS')) {
          miss(`${name}: pnpm did not report the ignored build script`);
        }
        if (!install.output.includes('planted-build-script')) {
          miss(`${name}: pnpm did not name the dependency`);
        }
        if (existsSync(marker)) {
          miss(`${name}: THE BUILD SCRIPT RAN, its marker file exists`);
        }
      }
    },
  );
  await testCase(
    'control: the same install runs the script once the guard is switched off, so the marker can be seen',
    (miss) => {
      rmSync(path.join(project, 'node_modules'), { recursive: true, force: true });
      const open = pnpmIn(
        project,
        ['install', '--frozen-lockfile', '--config.dangerouslyAllowAllBuilds=true'],
        env,
      );
      if (open.status !== 0) {
        miss(`the install without the guard failed:\n${open.output.slice(-400)}`);
      }
      if (!existsSync(marker)) {
        miss('the marker file does not exist: this test could not have seen a script run');
      }
    },
  );
}

// ---------------------------------------------------------------------------

let exitCode;
try {
  process.stdout.write('\nSupply chain: planted cases (ST-11)\n');
  const files = copyRepository();
  const install = pnpmIn(copy, ['install', '--frozen-lockfile']);
  if (install.status !== 0) {
    throw new Error(`the copy could not be installed:\n${install.output.slice(-1200)}`);
  }
  process.stdout.write(
    `  copied ${String(files)} files into tmp/ and installed them with a frozen lockfile\n`,
  );

  await frozenLockfile();
  await plantedSecrets();
  await weakenedRules();
  await vulnerablePackage();
  await unlistedBuildScript();

  const missed = results.filter(({ problems }) => problems.length > 0);
  const total = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    missed.length === 0
      ? `\nall ${String(results.length)} planted cases were caught in ${total} s\n`
      : `\n${String(missed.length)} of ${String(results.length)} planted cases were NOT caught (${total} s)\n`,
  );
  exitCode = missed.length === 0 ? 0 : 1;
} catch (error) {
  process.stderr.write(
    `\nplanted cases could not run: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  exitCode = 1;
} finally {
  cleanUp();
}

// Nothing may be left behind, and the working tree must be as it was.
if (existsSync(workRoot)) {
  process.stderr.write(
    `the copy under ${path.relative(repoRoot, workRoot)} could not be removed\n`,
  );
  exitCode = 1;
}
process.exit(exitCode);
