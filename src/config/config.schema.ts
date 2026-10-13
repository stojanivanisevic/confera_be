import { z } from 'zod';

/**
 * The configuration schema: every environment variable the API understands.
 *
 * Rules (ADR-01, ADR-24):
 * - `src/config` is the only place that reads the environment; a lint rule enforces it.
 * - A missing or invalid value stops the start, and the message names the variable.
 *   A message never repeats a value, because values can be secrets.
 * - `STAGE` has no default.
 *
 * `.env.example` documents the same variables; a unit test keeps the two in step.
 */

export const STAGES = ['local', 'dev', 'test', 'prod'] as const;
export type Stage = (typeof STAGES)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_PORT = 3001;

const PROBLEM = {
  stage: `is required and must be exactly one of: ${STAGES.join(', ')} (there is no default)`,
  port: 'must be a whole number between 1 and 65535',
  listenHost: 'must be an IP address or a host name without spaces',
  origin:
    'is required and must be an origin: scheme, host and optional port, nothing else (for example https://admin.example.org)',
  databaseUrl:
    'is required and must be a PostgreSQL address of the form postgresql://role:password@host:port/database',
  logLevel: `must be one of: ${LOG_LEVELS.join(', ')}`,
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

export const environmentSchema = z.object({
  STAGE: z.enum(STAGES, { error: PROBLEM.stage }),
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
    description: `Lowest level that is logged: ${LOG_LEVELS.join(', ')}. Default info.`,
    secret: false,
    required: false,
  },
} as const satisfies Record<VariableName, VariableInfo>;

export const VARIABLE_NAMES = Object.keys(VARIABLES) as VariableName[];

export const SECRET_VARIABLE_NAMES = VARIABLE_NAMES.filter((name) => VARIABLES[name].secret);
