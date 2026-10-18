// Who may deploy and publish (SEC-M4I-03): a check of the workflows, without GitHub.
//
//   node deploy/checks/workflows.mjs [<repository root> ...]     (default: this repository)
//
// Reads .github/workflows/image.yml and deploy-staging.yml of each repository given (confera_be,
// and confera_fe's checkout when named), and proves on the files themselves:
//   - every job that deploys (environment: staging) or publishes (packages: write) has an `if`
//     that, evaluated for each actor, re-run actor, ref and setting below, lets it run ONLY for a
//     run Stojan started (github.actor and github.triggering_actor), only from develop (deploy)
//     or develop and v* tags (publish), and only once IMAGE_PUBLISH_ENABLED is true (publish);
//   - for every case in which such a job is skipped although someone asked for it, a job of the
//     same workflow fails instead (a loud refusal, never a quiet green run);
//   - the first step of each such job is "Refuse anyone but the owner", and its shell script,
//     run here with bash, fails for anyone else and for another ref, and passes for Stojan.
// The expression evaluator covers what these `if`s use: ==, !=, &&, ||, !, parentheses,
// startsWith(), strings and the contexts github.* and vars.*. An `if` using anything else fails
// the check. Plain Node, no dependency, no Docker.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLog, createResults, repoRoot } from './lib.mjs';

const OWNER = 'stojanivanisevic';
const log = createLog('workflows');
const results = createResults(log);
const { check } = results;

// ---- A minimal reader of the workflow files: the jobs, their `if`, their steps ------------------
function jobsOf(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('jobs:');
  const jobs = {};
  let current;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      current = { name: job[1], lines: [] };
      jobs[job[1]] = current;
    } else if (current) current.lines.push(line);
  }
  for (const job of Object.values(jobs)) {
    job.text = job.lines.join('\n');
    job.if = ifOf(job.lines);
    job.deploys = /^ {4}environment: staging\s*$/m.test(job.text);
    job.publishes = /^ {6}packages: write\s*$/m.test(job.text);
    job.firstStep = /^ {4}steps:\n(?: {6}#.*\n)* {6}- name: (.+)$/m.exec(job.text)?.[1];
  }
  return jobs;
}

function ifOf(lines) {
  const index = lines.findIndex((line) => /^ {4}if:/.test(line));
  if (index < 0) return undefined;
  const inline = /^ {4}if:\s*(.+)$/.exec(lines[index])[1].trim();
  if (inline !== '>-' && inline !== '>') return inline;
  const folded = [];
  for (let i = index + 1; i < lines.length && /^ {6}/.test(lines[i]); i += 1)
    folded.push(lines[i].trim());
  return folded.join(' ');
}

/** The `run: |` script of the step with this name in a job. */
function stepScript(job, name) {
  const lines = job.lines;
  const at = lines.findIndex((line) => line === `      - name: ${name}`);
  if (at < 0) return undefined;
  const run = lines.findIndex((line, i) => i > at && line === '        run: |');
  if (run < 0) return undefined;
  const script = [];
  for (let i = run + 1; i < lines.length && (/^ {10}/.test(lines[i]) || lines[i] === ''); i += 1)
    script.push(lines[i].slice(10));
  return script.join('\n');
}

// ---- The evaluator --------------------------------------------------------------------------------
function tokenize(source) {
  const tokens = [];
  const pattern = /\s*(?:(==|!=|&&|\|\||[!(),])|'((?:[^']|'')*)'|([A-Za-z_][A-Za-z0-9_.-]*))/y;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new Error(`cannot read the expression at: ${source.slice(index)}`);
    if (match[1]) tokens.push({ op: match[1] });
    else if (match[2] !== undefined) tokens.push({ string: match[2].replaceAll("''", "'") });
    else tokens.push({ name: match[3] });
    index = pattern.lastIndex;
  }
  return tokens;
}

function evaluate(source, context) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = (op) => {
    const token = tokens[position];
    if (op && token?.op !== op) throw new Error(`expected ${op} in: ${source}`);
    position += 1;
    return token;
  };
  const value = (name) => {
    if (!/^(github|vars)\.[A-Za-z_]+$/.test(name)) throw new Error(`unknown context ${name}`);
    return context[name] ?? '';
  };
  function primary() {
    const token = take();
    if (token?.op === '!') return !truthy(primary());
    if (token?.op === '(') {
      const inner = or();
      take(')');
      return inner;
    }
    if (token?.string !== undefined) return token.string;
    if (token?.name === 'startsWith') {
      take('(');
      const a = or();
      take(',');
      const b = or();
      take(')');
      return String(a).toLowerCase().startsWith(String(b).toLowerCase());
    }
    if (token?.name) return value(token.name);
    throw new Error(`unexpected token in: ${source}`);
  }
  function comparison() {
    let left = primary();
    while (peek()?.op === '==' || peek()?.op === '!=') {
      const op = take().op;
      const right = primary();
      const equal = String(left).toLowerCase() === String(right).toLowerCase();
      left = op === '==' ? equal : !equal;
    }
    return left;
  }
  function and() {
    let left = comparison();
    while (peek()?.op === '&&') {
      take();
      const right = comparison();
      left = truthy(left) && truthy(right);
    }
    return left;
  }
  function or() {
    let left = and();
    while (peek()?.op === '||') {
      take();
      const right = and();
      left = truthy(left) || truthy(right);
    }
    return left;
  }
  const truthy = (v) => v !== false && v !== '' && v !== 0 && v !== null && v !== undefined;
  const result = or();
  if (position !== tokens.length) throw new Error(`left over tokens in: ${source}`);
  return truthy(result);
}

// ---- The cases --------------------------------------------------------------------------------------
const actors = [OWNER, 'confera-bot', 'a-collaborator', 'Stojanivanisevic-not', ''];
const refs = [
  'refs/heads/develop',
  'refs/heads/main',
  'refs/heads/feature/x',
  'refs/tags/v0.4.0',
  'refs/tags/x0.4.0',
  'refs/pull/7/merge',
];
const cases = [];
for (const actor of actors)
  for (const triggering of actors)
    for (const ref of refs)
      for (const enabled of ['true', 'false'])
        cases.push({
          'github.actor': actor,
          'github.triggering_actor': triggering,
          'github.ref': ref,
          'vars.IMAGE_PUBLISH_ENABLED': enabled,
          'vars.STAGING_DEPLOY_ENABLED': 'true',
        });
const byOwner = (c) => c['github.actor'] === OWNER && c['github.triggering_actor'] === OWNER;

// On Windows, `bash` on the PATH may be WSL's, which does not see this process's environment:
// take Git for Windows' bash there (or CONFERA_BASH).
const bashPath =
  process.env.CONFERA_BASH ??
  (process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
    ? 'C:/Program Files/Git/bin/bash.exe'
    : 'bash');

function bash(script, env) {
  const result = spawnSync(bashPath, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
}

function checkWorkflow(repository, file, kind) {
  const where = `${path.basename(repository)}/${file}`;
  const full = path.join(repository, '.github', 'workflows', file);
  if (!existsSync(full)) {
    check(`${where} exists`, false);
    return;
  }
  const jobs = jobsOf(readFileSync(full, 'utf8'));
  const guarded = Object.values(jobs).filter((job) =>
    kind === 'deploy' ? job.deploys : job.publishes,
  );
  check(`${where}: has its ${kind} job`, guarded.length === 1, guarded.map((j) => j.name).join());
  const job = guarded[0];
  if (!job) return;
  const allowedRef = (ref) =>
    kind === 'deploy'
      ? ref === 'refs/heads/develop'
      : ref === 'refs/heads/develop' || ref.startsWith('refs/tags/v');
  const shouldRun = (c) =>
    byOwner(c) &&
    allowedRef(c['github.ref']) &&
    (kind === 'deploy' || c['vars.IMAGE_PUBLISH_ENABLED'] === 'true');
  // A skip must be loud where someone could have expected the job: a deploy is always asked for
  // (it is dispatched by hand); a publish, when publishing is on and the ref may publish.
  const asked = (c) =>
    kind === 'deploy' ||
    (c['vars.IMAGE_PUBLISH_ENABLED'] === 'true' && allowedRef(c['github.ref']));

  let wrong = [];
  let quiet = [];
  try {
    const others = Object.values(jobs).filter((other) => other !== job && other.if);
    for (const c of cases) {
      const runs = job.if !== undefined && evaluate(job.if, c);
      if (runs !== shouldRun(c)) wrong.push(c);
      const refusedLoudly = others.some(
        (other) => evaluate(other.if, c) && /exit 1\s*$/.test(other.text.trimEnd()),
      );
      if (!runs && asked(c) && !refusedLoudly) quiet.push(c);
      if (runs && refusedLoudly) wrong.push({ ...c, both: true });
    }
  } catch (error) {
    wrong = [{ error: String(error) }];
  }
  const show = (list) => JSON.stringify(list.slice(0, 2));
  check(
    `${where}: ${job.name} runs only in a run Stojan started (actor and re-run actor), ${kind === 'deploy' ? 'from develop' : 'from develop or a v* tag, once IMAGE_PUBLISH_ENABLED is true'} (${String(cases.length)} cases)`,
    wrong.length === 0,
    show(wrong),
  );
  check(
    `${where}: whenever ${job.name} is skipped for someone else or another ref, another job fails loudly`,
    quiet.length === 0,
    show(quiet),
  );
  check(
    `${where}: the first step of ${job.name} is "Refuse anyone but the owner"`,
    job.firstStep === 'Refuse anyone but the owner',
    String(job.firstStep),
  );
  const script = stepScript(job, 'Refuse anyone but the owner');
  if (!script) {
    check(`${where}: the owner step has a script`, false);
    return;
  }
  const scriptCases = [
    [OWNER, OWNER, 'refs/heads/develop', 0],
    [OWNER, OWNER, 'refs/heads/feature/x', 1],
    ['confera-bot', OWNER, 'refs/heads/develop', 1],
    [OWNER, 'confera-bot', 'refs/heads/develop', 1],
    ['', '', 'refs/heads/develop', 1],
    ...(kind === 'publish'
      ? [
          [OWNER, OWNER, 'refs/tags/v0.4.0', 0],
          ['confera-bot', 'confera-bot', 'refs/tags/v0.4.0', 1],
          [OWNER, OWNER, 'refs/tags/x0.4.0', 1],
        ]
      : [[OWNER, OWNER, 'refs/tags/v0.4.0', 1]]),
  ];
  const failures = scriptCases.filter(
    ([actor, triggering, ref, expected]) =>
      bash(script, { ACTOR: actor, TRIGGERING_ACTOR: triggering, REF: ref }) !== expected,
  );
  check(
    `${where}: the owner step's script passes for Stojan only, and only on its refs (${String(scriptCases.length)} cases, bash)`,
    failures.length === 0,
    JSON.stringify(failures),
  );
}

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [repoRoot];
for (const root of roots) {
  const repository = path.resolve(root);
  checkWorkflow(repository, 'deploy-staging.yml', 'deploy');
  checkWorkflow(repository, 'image.yml', 'publish');
}
process.stdout.write(
  `\n${String(results.count - results.failed)} passed, ${String(results.failed)} failed; log ${log.file}\n`,
);
process.exit(results.failed === 0 ? 0 : 1);
