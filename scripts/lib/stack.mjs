// One development stack per checkout (M1-ISS-13).
//
// Every checkout of this repository (a clone, a git worktree, a scratch copy) has a Docker
// Compose project of its own: its own containers, its own database volume and its own
// ports on 127.0.0.1. Two checkouts can run their test suites at the same time, and
// neither can stop, empty or drop the database of the other.
//
//   - The NAME of the project is derived from the folder of the checkout
//     (`confera-<folder>-<8 hex digits of its path>`), or set with CONFERA_STACK_NAME.
//   - The PORTS are what .env says: the port of the three database addresses (they must
//     agree), CONFERA_MAIL_WEB_PORT and CONFERA_MAIL_SMTP_PORT. `stack:ports` writes a free
//     set derived from the checkout into .env.
//   - Every command that uses the database first asks Docker which container publishes
//     the port of its address, and refuses when that container belongs to another
//     checkout, or to no Confera stack at all.
//
// Plain Node, no dependencies; the Docker command line is the only thing it calls.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { repoRoot } from './process.mjs';

/** The ports of a fresh `.env` (copied from .env.example): the standard ones. */
export const STANDARD_PORTS = { database: 5432, mailWeb: 8025, mailSmtp: 1025 };

/** The three database addresses of .env. The stack serves all three, so they name one port. */
export const DATABASE_VARIABLES = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'MIGRATION_DATABASE_URL'];

/** Labels Docker Compose puts on every container of a project. */
const PROJECT_LABEL = 'com.docker.compose.project';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

/** What to do about a refusal, said once at the end of every refusal. */
export const REMEDY =
  'Give this checkout ports of its own with "corepack pnpm stack:ports", then "corepack pnpm stack:up" (README, section 2).';

/** A refusal: a sentence for the person at the terminal. It never holds a password. */
export class StackRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'StackRefusal';
  }
}

/** A path as it is compared: absolute, without a trailing separator, and in lower case on Windows. */
export function comparablePath(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The name of the Compose project of a checkout: CONFERA_STACK_NAME when it is set, else
 * `confera-<folder>-<the first 8 hex digits of the SHA-256 of its path>`. Two checkouts in
 * two folders get two names, also when the folders have the same name.
 */
export function stackName(env = process.env, root = repoRoot) {
  const chosen = env.CONFERA_STACK_NAME;
  if (chosen !== undefined && chosen !== '') {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(chosen)) {
      throw new StackRefusal(
        'CONFERA_STACK_NAME must be lower-case letters, digits, "-" and "_", starting with a letter or a digit.',
      );
    }
    return chosen;
  }
  const folder =
    path
      .basename(path.resolve(root))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^confera-?/, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'checkout';
  const digest = createHash('sha256').update(comparablePath(root)).digest('hex').slice(0, 8);
  return `confera-${folder}-${digest}`;
}

/** A port number written in a variable, or the standard one when the variable is not set. */
function portOf(env, variable, standard) {
  const value = env[variable];
  if (value === undefined || value === '') {
    return standard;
  }
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) {
    throw new StackRefusal(`${variable} must be a port number between 1 and 65535.`);
  }
  return Number(value);
}

export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

/** The port of a database address, or null when the address is not one on this machine. */
export function loopbackPortOf(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  return isLoopbackHost(url.hostname) ? Number(url.port || 5432) : null;
}

/**
 * The ports of the stack of this checkout, as .env gives them. The database port is the
 * port of the three database addresses, which must agree; the mail catcher has two
 * variables of its own.
 */
export function stackPorts(env = process.env) {
  const databasePorts = new Set();
  for (const variable of DATABASE_VARIABLES) {
    const value = env[variable];
    if (value !== undefined && value !== '') {
      const port = loopbackPortOf(value);
      if (port !== null) {
        databasePorts.add(port);
      }
    }
  }
  if (databasePorts.size > 1) {
    throw new StackRefusal(
      `the three database addresses (${DATABASE_VARIABLES.join(', ')}) name different ports (${[...databasePorts].join(', ')}); the stack has one PostgreSQL. Give all three the same port.`,
    );
  }
  const ports = {
    database: [...databasePorts][0] ?? STANDARD_PORTS.database,
    mailWeb: portOf(env, 'CONFERA_MAIL_WEB_PORT', STANDARD_PORTS.mailWeb),
    mailSmtp: portOf(env, 'CONFERA_MAIL_SMTP_PORT', STANDARD_PORTS.mailSmtp),
  };
  if (new Set(Object.values(ports)).size !== 3) {
    throw new StackRefusal(
      `PostgreSQL (${ports.database}), the web screen of the mail catcher (${ports.mailWeb}) and its SMTP port (${ports.mailSmtp}) need three different ports.`,
    );
  }
  return ports;
}

/** Runs the Docker command line and returns what it printed. Throws when Docker does not answer. */
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Every running container with the ports it publishes on the host and, when Compose
 * made it, its project and the folder of that project.
 * @returns {{ name: string, project: string | null, workingDir: string | null, ports: number[] }[]}
 */
export function runningContainers() {
  let ids;
  try {
    ids = docker(['ps', '--quiet', '--no-trunc'])
      .split(/\r?\n/)
      .filter((id) => id !== '');
  } catch (error) {
    throw new StackRefusal(
      `Docker does not answer (${error?.code ?? 'no error code'}). The development stack runs in Docker: start Docker Desktop and run the command again.`,
    );
  }
  if (ids.length === 0) {
    return [];
  }
  let inspected;
  try {
    inspected = JSON.parse(docker(['inspect', ...ids]));
  } catch {
    // A container that stopped between the two calls: ask again once.
    const again = docker(['ps', '--quiet', '--no-trunc'])
      .split(/\r?\n/)
      .filter((id) => id !== '');
    inspected = again.length === 0 ? [] : JSON.parse(docker(['inspect', ...again]));
  }
  return inspected.map((container) => {
    const labels = container.Config?.Labels ?? {};
    const bindings = Object.values(container.NetworkSettings?.Ports ?? {}).flatMap(
      (list) => list ?? [],
    );
    return {
      name: String(container.Name ?? '').replace(/^\//, ''),
      project: labels[PROJECT_LABEL] ?? null,
      workingDir: labels[WORKING_DIR_LABEL] ?? null,
      ports: [...new Set(bindings.map((binding) => Number(binding.HostPort)))].filter(
        (port) => Number.isInteger(port) && port > 0,
      ),
    };
  });
}

/**
 * The running containers, or none when Docker does not answer: without Docker no stack of
 * any checkout can be serving a port, so there is nothing to compare. (The commands that
 * then try the database say for themselves that nothing answers.)
 */
export function runningContainersIfAny() {
  try {
    return runningContainers();
  } catch (error) {
    if (error instanceof StackRefusal) {
      return [];
    }
    throw error;
  }
}

/** True when a container was started by the stack of the checkout at `root`. */
export function belongsTo(container, root = repoRoot) {
  return (
    container.workingDir !== null && comparablePath(container.workingDir) === comparablePath(root)
  );
}

/**
 * Why the port must not be used by this checkout, or null when it may: no container
 * publishes it, or only containers of this checkout's own stack do.
 * @param {string} what what is at the port, for the sentence ("the database of DATABASE_URL")
 */
export function foreignOwner({ port, containers, root = repoRoot, what }) {
  const foreign = containers.find(
    (container) => container.ports.includes(port) && !belongsTo(container, root),
  );
  if (foreign === undefined) {
    return null;
  }
  if (foreign.workingDir !== null) {
    return `${what} at 127.0.0.1:${port} belongs to the stack "${foreign.project ?? '?'}" of another checkout, ${foreign.workingDir}, not to this checkout, ${path.resolve(root)}.`;
  }
  return `${what} at 127.0.0.1:${port} is served by the container "${foreign.name}", which is not the stack of this checkout, ${path.resolve(root)}.`;
}

/**
 * Refuses when the database a variable points at belongs to the stack of another checkout,
 * or to a container that is not a Confera stack at all. An address that is not on this
 * machine (a server, PROVISION_DATABASE_URL) is not the development stack and is not judged.
 */
export function assertOwnDatabase(variables, env = process.env, root = repoRoot) {
  const checked = variables
    .map((variable) => ({ variable, port: env[variable] ? loopbackPortOf(env[variable]) : null }))
    .filter(({ port }) => port !== null);
  if (checked.length === 0) {
    return;
  }
  const containers = runningContainersIfAny();
  for (const { variable, port } of checked) {
    const problem = foreignOwner({
      port,
      containers,
      root,
      what: `the database of ${variable}`,
    });
    if (problem !== null) {
      throw new StackRefusal(`${problem} ${REMEDY}`);
    }
  }
}

/**
 * The guard of a command that uses the database: prints why it does not run and ends the
 * process with exit code 1, before anything else happens. Returns when the database is
 * this checkout's own (or not on this machine).
 */
export function refuseUnlessOwnDatabase(tool, variables, env = process.env) {
  try {
    assertOwnDatabase(variables, env);
  } catch (error) {
    if (error instanceof StackRefusal) {
      process.stderr.write(`${tool} did not run: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

/** True when nothing listens on the port of 127.0.0.1. */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * A set of three ports derived from the checkout: the same folder always gets the same
 * set, two folders almost never the same one. 25000 + n for PostgreSQL, 26000 + n and
 * 27000 + n for the mail catcher, with n from the SHA-256 of the path.
 */
export function derivedPorts(root = repoRoot, step = 0) {
  const digest = createHash('sha256').update(comparablePath(root)).digest();
  const n = (digest.readUInt32BE(0) + step) % 1000;
  return { database: 25000 + n, mailWeb: 26000 + n, mailSmtp: 27000 + n };
}
