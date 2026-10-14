// The development stack of THIS checkout (ADR-24, M1-ISS-13): PostgreSQL and the mail
// catcher in Docker, under a Compose project of its own.
//
//   corepack pnpm stack:up        starts it (refuses ports that another checkout uses)
//   corepack pnpm stack:down      stops it; the database stays in the volume of this checkout
//   corepack pnpm stack:wipe      stops it and removes the volume of this checkout
//   corepack pnpm stack:ports     writes a free set of ports, derived from the checkout, into .env
//   corepack pnpm stack:info      says the name, the ports and the folder of this checkout's stack
//
//   node scripts/stack.mjs check-database VARIABLE...
//       the guard of the database commands: refuses when the database of one of the
//       variables belongs to another checkout (scripts/lib/stack.mjs)
//
// The name and the ports are the rules of scripts/lib/stack.mjs. docker-compose.yml takes
// them from the variables this script sets, and refuses to start without them, so the
// stack is always started through this script.
import { spawnSync } from 'node:child_process';
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

/** The variables docker-compose.yml needs, for this checkout. */
function composeEnvironment(name, ports) {
  return {
    ...process.env,
    CONFERA_STACK_NAME: name,
    CONFERA_DB_PORT: String(ports.database),
    CONFERA_MAIL_WEB_PORT: String(ports.mailWeb),
    CONFERA_MAIL_SMTP_PORT: String(ports.mailSmtp),
  };
}

function compose(name, ports, args) {
  const result = spawnSync('docker', ['compose', '--project-name', name, ...args], {
    cwd: repoRoot,
    env: composeEnvironment(name, ports),
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

function describe(name, ports) {
  return [
    `  project      ${name}`,
    `  checkout     ${repoRoot}`,
    `  PostgreSQL   127.0.0.1:${ports.database}`,
    `  mail catcher http://127.0.0.1:${ports.mailWeb} (web), 127.0.0.1:${ports.mailSmtp} (SMTP)`,
  ].join('\n');
}

async function up() {
  const name = stackName();
  const ports = stackPorts();
  const containers = runningContainers();
  const what = {
    database: 'PostgreSQL',
    mailWeb: 'the web screen of the mail catcher',
    mailSmtp: 'the SMTP port of the mail catcher',
  };
  for (const [kind, port] of Object.entries(ports)) {
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
  const code = compose(name, ports, ['up', '--detach', '--wait']);
  if (code === 0) {
    process.stdout.write(`\nThe stack of this checkout is up.\n${describe(name, ports)}\n`);
  }
  return code;
}

function down(volumes) {
  const name = stackName();
  const ports = stackPorts();
  return compose(name, ports, ['down', ...(volumes ? ['--volumes'] : [])]);
}

/**
 * Writes into .env a set of ports derived from the folder of the checkout: the port of the
 * three database addresses and the two ports of the mail catcher. Nothing else in .env
 * changes. A port that something already uses is skipped for the next set.
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
    case 'check-database':
      refuseUnlessOwnDatabase(
        rest[0] === '--tool' ? rest[1] : 'the command',
        rest[0] === '--tool' ? rest.slice(2) : rest,
      );
      process.exit(0);
      break;
    default:
      process.stderr.write(
        'Usage: node scripts/stack.mjs (up | down | wipe | ports | info | check-database [--tool <name>] VARIABLE...)\n',
      );
      process.exit(2);
  }
} catch (error) {
  if (error instanceof StackRefusal) {
    refuse(command, error.message);
  }
  throw error;
}
