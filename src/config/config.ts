import {
  DEFAULT_PORT,
  type Environment,
  environmentSchema,
  type Instance,
  type LogLevel,
  type Stage,
  VARIABLE_NAMES,
} from './config.schema';
import { Secret } from './secret';
import { stageGuardProblems } from './stage-guard';

/** The validated configuration. Injected with `@Inject(APP_CONFIG)`; never read from the environment elsewhere. */
export interface AppConfig {
  readonly stage: Stage;
  /** `production` or `staging` on a `prod` stage; `null` on a developer machine. */
  readonly instance: Instance | null;
  readonly http: {
    readonly port: number;
    readonly listenHost: string;
  };
  readonly origins: {
    /** Origin of the admin surface, for example https://admin.example.org */
    readonly admin: string;
    /** Origin of the public surface, for example https://forms.example.org */
    readonly public: string;
  };
  readonly database: {
    readonly applicationUrl: Secret;
    readonly systemUrl: Secret;
  };
  readonly logLevel: LogLevel;
  /**
   * Development conveniences. Every flag is false unless STAGE is local or dev, because
   * the guard refuses the `DEV_*` keys everywhere else; and the code that acts on them
   * lives in the dev-tools module, which the production build does not contain.
   */
  readonly devTools: {
    readonly apiDocs: boolean;
    readonly logQueries: boolean;
  };
}

export interface ConfigProblem {
  /** Name of the environment variable. Never its value. */
  readonly variable: string;
  readonly problem: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export type RawEnvironment = Readonly<Record<string, string | undefined>>;

function toConfig(env: Environment): AppConfig {
  return {
    stage: env.STAGE,
    instance: env.INSTANCE ?? null,
    http: {
      port: env.PORT ?? DEFAULT_PORT,
      listenHost: env.LISTEN_HOST ?? (env.STAGE === 'prod' ? '0.0.0.0' : '127.0.0.1'),
    },
    origins: {
      admin: env.ADMIN_ORIGIN,
      public: env.PUBLIC_ORIGIN,
    },
    database: {
      applicationUrl: new Secret(env.DATABASE_URL),
      systemUrl: new Secret(env.SYSTEM_DATABASE_URL),
    },
    logLevel: env.LOG_LEVEL ?? 'info',
    devTools: {
      apiDocs: env.DEV_API_DOCS ?? false,
      logQueries: env.DEV_LOG_QUERIES ?? false,
    },
  };
}

/**
 * Turns an environment into a configuration, or into the list of what is wrong with it.
 * Pure: it reads nothing but its argument, so tests and tools can call it with any record.
 */
export function parseEnvironment(env: RawEnvironment): ConfigResult {
  const known: Record<string, string | undefined> = {};
  for (const name of VARIABLE_NAMES) {
    known[name] = env[name];
  }

  const problems: ConfigProblem[] = [];
  const parsed = environmentSchema.safeParse(known);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const variable = typeof issue.path[0] === 'string' ? issue.path[0] : '(environment)';
      problems.push({ variable, problem: issue.message });
    }
  }
  problems.push(...stageGuardProblems(env));

  if (!parsed.success || problems.length > 0) {
    return { ok: false, problems: sortProblems(problems) };
  }
  return { ok: true, config: toConfig(parsed.data) };
}

function sortProblems(problems: readonly ConfigProblem[]): ConfigProblem[] {
  const seen = new Set<string>();
  const unique: ConfigProblem[] = [];
  for (const problem of problems) {
    const key = `${problem.variable}\u0000${problem.problem}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(problem);
    }
  }
  return unique.sort((a, b) => a.variable.localeCompare(b.variable));
}

/** The text printed when the start is refused. One line per variable; no values. */
export function formatProblems(problems: readonly ConfigProblem[]): string {
  const lines = problems.map(({ variable, problem }) => `  - ${variable}: ${problem}`);
  return [
    'Confera API did not start: the configuration is not valid.',
    ...lines,
    'See .env.example for every variable.',
    '',
  ].join('\n');
}
