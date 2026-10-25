// The development stack of THIS checkout (ADR-24, M1-ISS-13): PostgreSQL, the mail catcher
// and the fake clamd in Docker, under a Compose project of its own.
//
//   corepack pnpm stack:up        starts it (refuses ports that another checkout uses)
//   corepack pnpm stack:down      stops it; the database stays in the volume of this checkout
//   corepack pnpm stack:wipe      stops it and removes the volume of this checkout
//   corepack pnpm stack:ports     writes a free set of ports, derived from the checkout, into .env
//   corepack pnpm stack:info      says the name, the ports and the folder of this checkout's stack
//   corepack pnpm stack:clamd     runs the fake clamd in this terminal instead of in Docker
//
// The fake clamd (scripts/fake-clamd.mjs) is optional: CONFERA_FAKE_CLAMD=off in .env leaves it
// out of stack:up, and then every uploaded file stays "scan pending" (fail closed). It is on by
// default, and .env.example points CLAMAV_ADDRESS at it.
//
//   node scripts/stack.mjs check-database VARIABLE...
//       the guard of the database commands: refuses when the database of one of the
//       variables belongs to another checkout (scripts/lib/stack.mjs)
//
// The name and the ports are the rules of scripts/lib/stack.mjs. docker-compose.yml takes
// them from the variables this script sets, and refuses to start without them, so the
// stack is always started through this script.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadDotEnv, repoRoot } from './lib/process.mjs';
import {
  DATABASE_VARIABLES,
  derivedPorts,
  foreignOwner,
  portIsFree,
  REMEDY,
  refuseUnlessOwnDatabase,
  runningContainers,
  StackRefusal,
  stackName,
  stackPorts,
} from './lib/stack.mjs';

const ENV_FILE = path.join(repoRoot, '.env');

function refuse(command, message) {
  process.stderr.write(`stack:${command} did not run: ${message}\n`);
  process.exit(1);
}

/** The Compose profile of the fake clamd, an optional service of docker-compose.yml. */
const CLAMD_PROFILE = 'fake-clamd';

/** Whether stack:up starts the fake clamd: on unless CONFERA_FAKE_CLAMD=off. */
function fakeClamdWanted(env = process.env) {
  const value = env.CONFERA_FAKE_CLAMD;
  if (value === undefined || value === '' || value === 'on') {
    return true;
  }
  if (value === 'off') {
    return false;
  }
  throw new StackRefusal('CONFERA_FAKE_CLAMD must be "on" or "off".');
}

/** The variables docker-compose.yml needs, for this checkout. */
function composeEnvironment(name, ports, withClamd) {
  const environment = { ...process.env };
  delete environment.COMPOSE_PROFILES;
  return {
    ...environment,
    ...(withClamd ? { COMPOSE_PROFILES: CLAMD_PROFILE } : {}),
    CONFERA_STACK_NAME: name,
    CONFERA_DB_PORT: String(ports.database),
    CONFERA_MAIL_WEB_PORT: String(ports.mailWeb),
    CONFERA_MAIL_SMTP_PORT: String(ports.mailSmtp),
    CONFERA_CLAMD_PORT: String(ports.clamd),
  };
}

function compose(name, ports, args, withClamd = true) {
  const result = spawnSync('docker', ['compose', '--project-name', name, ...args], {
    cwd: repoRoot,
    env: composeEnvironment(name, ports, withClamd),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw new StackRefusal(
      `Docker does not answer (${result.error.code ?? 'no error code'}). Start Docker Desktop and run the command again.`,
    );
  }
  return result.status ?? 1;
}

function describe(name, ports, withClamd = fakeClamdWanted()) {
  return [
    `  project      ${name}`,
    `  checkout     ${repoRoot}`,
    `  PostgreSQL   127.0.0.1:${ports.database}`,
    `  mail catcher http://127.0.0.1:${ports.mailWeb} (web), 127.0.0.1:${ports.mailSmtp} (SMTP)`,
    withClamd
      ? `  fake clamd   127.0.0.1:${ports.clamd} (every file clean but EICAR; development only)`
      : '  fake clamd   off (CONFERA_FAKE_CLAMD=off): uploaded files stay "scan pending"',
  ].join('\n');
}

/** A note for the terminal when the API of this checkout would not ask the fake clamd. */
function clamdAddressNote(ports) {
  const address = process.env.CLAMAV_ADDRESS;
  if (address === `127.0.0.1:${ports.clamd}` || address === `localhost:${ports.clamd}`) {
    return '';
  }
  const what = address === undefined || address === '' ? 'not set' : 'another address';
  return `\nNote: CLAMAV_ADDRESS in .env is ${what}, so the API does not ask the fake clamd. For uploads and email images that become clean, set CLAMAV_ADDRESS=127.0.0.1:${ports.clamd} (README, section 2).\n`;
}

async function up() {
  const name = stackName();
  const ports = stackPorts();
  const withClamd = fakeClamdWanted();
  const containers = runningContainers();
  const what = {
    database: 'PostgreSQL',
    mailWeb: 'the web screen of the mail catcher',
    mailSmtp: 'the SMTP port of the mail catcher',
    clamd: 'the fake clamd',
  };
  for (const [kind, port] of Object.entries(ports)) {
    if (kind === 'clamd' && !withClamd) {
      continue;
    }
    const problem = foreignOwner({ port, containers, what: what[kind] });
    if (problem !== null) {
      throw new StackRefusal(`${problem} ${REMEDY}`);
    }
    const ownContainer = containers.some(
      (container) => container.project === name && container.ports.includes(port),
    );
    if (!ownContainer && !(await portIsFree(port))) {
      throw new StackRefusal(
        `port ${port} of 127.0.0.1, for ${what[kind]}, is in use by another program. ${REMEDY}`,
      );
    }
  }
  const code = compose(name, ports, ['up', '--detach', '--wait'], withClamd);
  if (code === 0) {
    process.stdout.write(
      `\nThe stack of this checkout is up.\n${describe(name, ports, withClamd)}\n${withClamd ? clamdAddressNote(ports) : ''}`,
    );
  }
  return code;
}

function down(volumes) {
  const name = stackName();
  const ports = stackPorts();
  // With the profile on, so that the fake clamd of an earlier stack:up stops too.
  return compose(name, ports, ['down', ...(volumes ? ['--volumes'] : [])], true);
}

/** The fake clamd in this terminal, on the port of this checkout, until Ctrl+C. */
function clamd() {
  const ports = stackPorts();
  process.stdout.write(clamdAddressNote(ports));
  const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'fake-clamd.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, FAKE_CLAMD_HOST: '127.0.0.1', FAKE_CLAMD_PORT: String(ports.clamd) },
    stdio: 'inherit',
    windowsHide: true,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * Writes into .env a set of ports derived from the folder of the checkout: the port of the
 * three database addresses, the two ports of the mail catcher and the port of the fake clamd,
 * with CLAMAV_ADDRESS when it names this machine. Nothing else in .env changes. A port that
 * something already uses is skipped for the next set.
 */
async function ports() {
  if (!existsSync(ENV_FILE)) {
    throw new StackRefusal(
      '.env does not exist. Copy .env.example to .env first (README, section 2).',
    );
  }
  const containers = runningContainers();
  const name = stackName();
  let chosen;
  for (let step = 0; step < 200 && chosen === undefined; step += 1) {
    const candidate = derivedPorts(repoRoot, step);
    let usable = true;
    for (const port of Object.values(candidate)) {
      const ours = containers.some(
        (container) => container.project === name && container.ports.includes(port),
      );
      if (!ours && (containers.some((c) => c.ports.includes(port)) || !(await portIsFree(port)))) {
        usable = false;
      }
    }
    if (usable) {
      chosen = candidate;
    }
  }
  if (chosen === undefined) {
    throw new StackRefusal('no free set of ports was found among 200 candidates.');
  }

  const lines = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  const found = new Set();
  const changed = lines.map((line) => {
    const pair = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (pair === null) {
      return line;
    }
    const [, variable, value] = pair;
    if (DATABASE_VARIABLES.includes(variable)) {
      found.add(variable);
      try {
        const url = new URL(value);
        url.port = String(chosen.database);
        return `${variable}=${url.toString()}`;
      } catch {
        throw new StackRefusal(`${variable} in .env is not a valid address.`);
      }
    }
    if (variable === 'CONFERA_MAIL_WEB_PORT') {
      found.add(variable);
      return `${variable}=${chosen.mailWeb}`;
    }
    if (variable === 'CONFERA_MAIL_SMTP_PORT') {
      found.add(variable);
      return `${variable}=${chosen.mailSmtp}`;
    }
    if (variable === 'CONFERA_CLAMD_PORT') {
      found.add(variable);
      return `${variable}=${chosen.clamd}`;
    }
    if (variable === 'CLAMAV_ADDRESS' && /^(127\.0\.0\.1|localhost):\d+$/.test(value)) {
      return `${variable}=127.0.0.1:${chosen.clamd}`;
    }
    return line;
  });
  for (const variable of DATABASE_VARIABLES) {
    if (!found.has(variable)) {
      throw new StackRefusal(`${variable} is missing in .env. Compare .env with .env.example.`);
    }
  }
  if (!found.has('CONFERA_MAIL_WEB_PORT')) {
    changed.push('# Port of the web screen of the mail catcher (written by stack:ports).');
    changed.push(`CONFERA_MAIL_WEB_PORT=${chosen.mailWeb}`);
  }
  if (!found.has('CONFERA_MAIL_SMTP_PORT')) {
    changed.push('# SMTP port of the mail catcher (written by stack:ports).');
    changed.push(`CONFERA_MAIL_SMTP_PORT=${chosen.mailSmtp}`);
  }
  if (!found.has('CONFERA_CLAMD_PORT')) {
    changed.push('# Port of the fake clamd on 127.0.0.1 (written by stack:ports).');
    changed.push(`CONFERA_CLAMD_PORT=${chosen.clamd}`);
  }
  writeFileSync(ENV_FILE, changed.join('\n'));
  process.stdout.write(
    [
      'The ports of this checkout are written into .env:',
      describe(name, chosen),
      'If the stack of this checkout was up on other ports: corepack pnpm stack:down, then corepack pnpm stack:up.',
      '',
    ].join('\n'),
  );
  return 0;
}

function info() {
  process.stdout.write(`${describe(stackName(), stackPorts())}\n`);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
loadDotEnv();
try {
  switch (command) {
    case 'up':
      process.exit(await up());
      break;
    case 'down':
      process.exit(down(false));
      break;
    case 'wipe':
      process.exit(down(true));
      break;
    case 'ports':
      process.exit(await ports());
      break;
    case 'info':
      process.exit(info());
      break;
    case 'clamd':
      clamd();
      break;
    case 'check-database':
      refuseUnlessOwnDatabase(
        rest[0] === '--tool' ? rest[1] : 'the command',
        rest[0] === '--tool' ? rest.slice(2) : rest,
      );
      process.exit(0);
      break;
    default:
      process.stderr.write(
        'Usage: node scripts/stack.mjs (up | down | wipe | ports | info | clamd | check-database [--tool <name>] VARIABLE...)\n',
      );
      process.exit(2);
  }
} catch (error) {
  if (error instanceof StackRefusal) {
    refuse(command, error.message);
  }
  throw error;
}
