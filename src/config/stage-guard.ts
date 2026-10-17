import type { ConfigProblem, RawEnvironment } from './config';
import {
  DEV_PREFIX,
  DEV_VARIABLE_NAMES,
  INSTANCES,
  type LogLevel,
  type Stage,
  STAGES,
} from './config.schema';

/**
 * The STAGE and INSTANCE guard (ADR-24, finding SEC-A-03, tests ST-01 to ST-04).
 *
 * What it guarantees:
 * - `local`, `dev` and `test` run only on a developer machine: their origins must be a
 *   loopback address or a `.test` name. Every server reachable from the Internet runs
 *   `prod`, the staging server included.
 * - On `prod`, `INSTANCE` is required and tells production from staging; a missing or
 *   misspelt value stops the start, so a staging server never silently counts as production.
 * - A `DEV_*` convenience exists only on `local` and `dev`. On `test` and `prod` every
 *   known `DEV_*` key stops the start, and an unknown `DEV_`-prefixed variable stops it
 *   on every stage (a typing mistake must not pass in silence).
 * - On `prod` the configuration is a positive allowlist. As modules arrive they add their
 *   rules here (PayPal environment, rate provider, antivirus, SMTP TLS, throttling).
 *
 * The guard reads the raw environment, so it also speaks when other variables are wrong.
 * Its messages name variables and never repeat a value.
 */

/** Stages on which the dev-tools module may exist. */
export const DEV_TOOL_STAGES: readonly Stage[] = ['local', 'dev'];

/** Levels that a server may log at. `debug` and `trace` can carry query values and payloads. */
export const PRODUCTION_LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info'];

/**
 * Credentials of tools, which must never sit in the environment of the running API on a
 * server: the owner role exists only in the migration job (ADR-05, ADR-26).
 */
export const TOOL_ONLY_VARIABLES = [
  'MIGRATION_DATABASE_URL',
  'PROVISION_DATABASE_URL',
  'POSTGRES_PASSWORD',
] as const;

const PROBLEM = {
  instanceRequired: `is required on STAGE=prod and must be exactly one of: ${INSTANCES.join(', ')} (there is no default)`,
  instanceForbidden: 'must not be set unless STAGE=prod',
  developerMachineOnly:
    'on STAGE=local, dev or test the host must be localhost, a loopback address or a name ending in .test: these stages run only on a developer machine, and every server runs STAGE=prod',
  loopbackOnly:
    'on STAGE=local, dev or test the API must listen on a loopback address only (127.0.0.1, ::1 or localhost): these stages run only on a developer machine, and every server runs STAGE=prod',
  httpsRequired: 'must use https on STAGE=prod',
  sameHost: 'must have another host name than ADMIN_ORIGIN (ADR-02: two surfaces, two host names)',
  devKeyRefused: `is a development convenience and stops the start unless STAGE is one of: ${DEV_TOOL_STAGES.join(', ')}`,
  devKeyUnknown: `is not a known ${DEV_PREFIX} variable (see src/config/config.schema.ts)`,
  logLevel: `must be one of ${PRODUCTION_LOG_LEVELS.join(', ')} on STAGE=prod`,
  requiredOnProd:
    'is required on STAGE=prod: a server keeps its uploaded files in a folder of its own and scans them (ADR-10)',
  toolOnly:
    'must not be present in the environment of the API on STAGE=prod: it belongs to the migration or provisioning job only',
} as const;

/**
 * An address to listen on that only this machine can reach: 127.0.0.0/8, ::1 or
 * localhost. A `.test` name is no such address: it may resolve to any interface.
 */
export function isLoopbackAddress(listenHost: string): boolean {
  const host = listenHost.toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(
      host,
    )
  );
}

export function isLoopbackOrTestHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]') {
    return true;
  }
  if (host.endsWith('.localhost') || host.endsWith('.test')) {
    return true;
  }
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host);
}

function parseUrl(value: string | undefined): URL | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function knownStage(value: string | undefined): Stage | undefined {
  return STAGES.find((stage) => stage === value);
}

export function stageGuardProblems(env: RawEnvironment): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const add = (variable: string, problem: string): void => {
    problems.push({ variable, problem });
  };

  // An unknown DEV_ variable is refused whatever the stage is, known or not.
  const known = new Set<string>(DEV_VARIABLE_NAMES);
  for (const name of Object.keys(env)) {
    if (name.startsWith(DEV_PREFIX) && env[name] !== undefined && !known.has(name)) {
      add(name, PROBLEM.devKeyUnknown);
    }
  }

  const stage = knownStage(env.STAGE);
  if (stage === undefined) {
    // config.schema.ts reports STAGE itself. Without a stage nothing below can be judged,
    // and the start is refused anyway.
    return problems;
  }

  if (!DEV_TOOL_STAGES.includes(stage)) {
    for (const name of DEV_VARIABLE_NAMES) {
      if (env[name] !== undefined) {
        add(name, PROBLEM.devKeyRefused);
      }
    }
  }

  const admin = parseUrl(env.ADMIN_ORIGIN);
  const publicOrigin = parseUrl(env.PUBLIC_ORIGIN);
  const origins: [string, URL | undefined][] = [
    ['ADMIN_ORIGIN', admin],
    ['PUBLIC_ORIGIN', publicOrigin],
  ];

  if (stage === 'prod') {
    if (env.INSTANCE === undefined) {
      add('INSTANCE', PROBLEM.instanceRequired);
    }
    for (const [name, url] of origins) {
      if (url !== undefined && url.protocol !== 'https:') {
        add(name, PROBLEM.httpsRequired);
      }
    }
    const level = env.LOG_LEVEL;
    if (level !== undefined && !PRODUCTION_LOG_LEVELS.some((allowed) => allowed === level)) {
      add('LOG_LEVEL', PROBLEM.logLevel);
    }
    for (const name of TOOL_ONLY_VARIABLES) {
      if (env[name] !== undefined) {
        add(name, PROBLEM.toolOnly);
      }
    }
    for (const name of ['FILE_STORAGE_DIR', 'CLAMAV_ADDRESS']) {
      if (env[name] === undefined || env[name] === '') {
        add(name, PROBLEM.requiredOnProd);
      }
    }
  } else {
    if (env.INSTANCE !== undefined) {
      add('INSTANCE', PROBLEM.instanceForbidden);
    }
    for (const [name, url] of origins) {
      if (url !== undefined && !isLoopbackOrTestHost(url.hostname)) {
        add(name, PROBLEM.developerMachineOnly);
      }
    }
    // Who can reach the API is decided by the address it listens on, not by the origins:
    // a dev stage listening on 0.0.0.0 answers anyone who sends `Host: localhost`.
    // (A value that is no address at all is named by the schema already.)
    const listenHost = env.LISTEN_HOST;
    if (
      listenHost !== undefined &&
      /^[A-Za-z0-9.:-]+$/.test(listenHost) &&
      !isLoopbackAddress(listenHost)
    ) {
      add('LISTEN_HOST', PROBLEM.loopbackOnly);
    }
  }

  if (admin !== undefined && admin.hostname === publicOrigin?.hostname) {
    add('PUBLIC_ORIGIN', PROBLEM.sameHost);
  }

  return problems;
}
