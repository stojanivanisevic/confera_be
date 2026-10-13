import { z } from 'zod';

/**
 * The configuration schema: every environment variable the API understands.
 *
 * Rules (ADR-01, ADR-24):
 * - `src/config` is the only place that reads the environment; a lint rule enforces it.
 * - A missing or invalid value stops the start, and the message names the variable.
 *   A message never repeats a value, because values can be secrets.
 * - `STAGE` and `INSTANCE` have no default.
 * - A variable whose name starts with `DEV_` switches a development convenience on.
 *   Such keys are listed here and nowhere else; the rules about them are in stage-guard.ts.
 *
 * `.env.example` documents the same variables; a test keeps the two in step.
 */

export const STAGES = ['local', 'dev', 'test', 'prod'] as const;
export type Stage = (typeof STAGES)[number];

/** Tells production from staging on a `prod` stage (ADR-24). Exactly two values, no default. */
export const INSTANCES = ['production', 'staging'] as const;
export type Instance = (typeof INSTANCES)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_PORT = 3001;

/** Prefix of the variables that switch a development convenience on. */
export const DEV_PREFIX = 'DEV_';

const PROBLEM = {
  stage: `is required and must be exactly one of: ${STAGES.join(', ')} (there is no default)`,
  instance: `must be exactly one of: ${INSTANCES.join(', ')} (there is no default)`,
  port: 'must be a whole number between 1 and 65535',
  listenHost: 'must be an IP address or a host name without spaces',
  origin:
    'is required and must be an origin: scheme, host and optional port, nothing else (for example https://admin.example.org)',
  databaseUrl:
    'is required and must be a PostgreSQL address of the form postgresql://role:password@host:port/database',
  logLevel: `must be one of: ${LOG_LEVELS.join(', ')}`,
  flag: 'must be exactly true or false',
} as const;

export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

export function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'postgresql:' || url.protocol === 'postgres:') &&
      url.username !== '' &&
      url.password !== '' &&
      url.hostname !== '' &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

const origin = z.string({ error: PROBLEM.origin }).refine(isOrigin, { error: PROBLEM.origin });

const databaseUrl = z
  .string({ error: PROBLEM.databaseUrl })
  .refine(isPostgresUrl, { error: PROBLEM.databaseUrl });

const flag = z
  .enum(['true', 'false'], { error: PROBLEM.flag })
  .transform((value) => value === 'true');

export const environmentSchema = z.object({
  STAGE: z.enum(STAGES, { error: PROBLEM.stage }),
  INSTANCE: z.enum(INSTANCES, { error: PROBLEM.instance }).optional(),
  PORT: z
    .string()
    .regex(/^[1-9]\d{0,4}$/, { error: PROBLEM.port })
    .transform(Number)
    .refine((port) => port <= 65535, { error: PROBLEM.port })
    .optional(),
  LISTEN_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.:-]+$/, { error: PROBLEM.listenHost })
    .optional(),
  ADMIN_ORIGIN: origin,
  PUBLIC_ORIGIN: origin,
  DATABASE_URL: databaseUrl,
  SYSTEM_DATABASE_URL: databaseUrl,
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: PROBLEM.logLevel }).optional(),
  DEV_API_DOCS: flag.optional(),
  DEV_LOG_QUERIES: flag.optional(),
});

export type Environment = z.infer<typeof environmentSchema>;
export type VariableName = keyof Environment;

export interface VariableInfo {
  /** Shown in `.env.example` and in the README. */
  readonly description: string;
  /** A secret is never printed. The canary test (ST-03) takes its list from here. */
  readonly secret: boolean;
  readonly required: boolean;
}

export const VARIABLES = {
  STAGE: {
    description: `Where this process runs: ${STAGES.join(', ')}. No default; anything else stops the start.`,
    secret: false,
    required: true,
  },
  INSTANCE: {
    description: `On STAGE=prod only, and required there: ${INSTANCES.join(' or ')}. No default.`,
    secret: false,
    required: false,
  },
  PORT: {
    description: `Port the API listens on. Default ${DEFAULT_PORT}.`,
    secret: false,
    required: false,
  },
  LISTEN_HOST: {
    description:
      'Address the API listens on. Default 127.0.0.1 outside prod (the developer machine only) and 0.0.0.0 on prod (inside its container).',
    secret: false,
    required: false,
  },
  ADMIN_ORIGIN: {
    description:
      'Origin of the admin surface, as the browser sees it. /api/v1 answers only under this host name (ADR-02).',
    secret: false,
    required: true,
  },
  PUBLIC_ORIGIN: {
    description:
      'Origin of the public surface (forms, embed, secure-link pages). /public/v1 answers only under this host name. Must be another host name than ADMIN_ORIGIN.',
    secret: false,
    required: true,
  },
  DATABASE_URL: {
    description:
      'PostgreSQL address of the APPLICATION role (confera_app): no schema rights, bound by row-level security.',
    secret: true,
    required: true,
  },
  SYSTEM_DATABASE_URL: {
    description:
      'PostgreSQL address of the SYSTEM role (confera_system): used only by the resolvers that find an organisation before one is known (ADR-05).',
    secret: true,
    required: true,
  },
  LOG_LEVEL: {
    description: `Lowest level that is logged: ${LOG_LEVELS.join(', ')}. Default info. On prod: info or higher.`,
    secret: false,
    required: false,
  },
  DEV_API_DOCS: {
    description:
      'Development convenience (STAGE=local or dev only): true serves the interactive API documentation.',
    secret: false,
    required: false,
  },
  DEV_LOG_QUERIES: {
    description:
      'Development convenience (STAGE=local or dev only): true logs every SQL statement. Never possible on a server.',
    secret: false,
    required: false,
  },
} as const satisfies Record<VariableName, VariableInfo>;

export const VARIABLE_NAMES = Object.keys(VARIABLES) as VariableName[];

export const SECRET_VARIABLE_NAMES = VARIABLE_NAMES.filter((name) => VARIABLES[name].secret);

/** Every `DEV_*` key the schema knows. The guard and its tests take the list from here. */
export const DEV_VARIABLE_NAMES = VARIABLE_NAMES.filter((name) => name.startsWith(DEV_PREFIX));
