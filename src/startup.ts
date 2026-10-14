import { type AppConfig, formatProblems } from './config/config';
import { loadConfig } from './config/env';
import { DEV_TOOL_STAGES } from './config/stage-guard';

/** Exit codes of a refused start, so that a script or a test can tell the reasons apart. */
export const EXIT_CODE = {
  /** The configuration is missing or invalid (EX_CONFIG of sysexits.h). */
  configuration: 78,
  /** The application itself refused, for example on a database role that is too powerful (EX_NOPERM). */
  refused: 77,
  /** Anything else that stopped the start. */
  failure: 1,
} as const;

export interface Entry {
  /** Set by the development entry only. Such a process refuses to run outside local and dev. */
  readonly developmentEntry?: boolean;
}

/**
 * The first thing an entry does: reads the environment and decides whether this process
 * may start at all. On a bad configuration it says which variable is wrong, sets exit
 * code 78 and returns nothing; the entry then loads nothing more and the process ends.
 *
 * This file imports the configuration module and nothing else, on purpose. The framework
 * and the application are loaded by the entry only after this has passed, so a refused
 * start costs a fraction of what a start costs and never runs application code.
 */
export function configurationOrRefusal(entry: Entry = {}): AppConfig | undefined {
  const loaded = loadConfig();
  if (!loaded.ok) {
    process.stderr.write(formatProblems(loaded.problems));
    process.exitCode = EXIT_CODE.configuration;
    return undefined;
  }
  const { config } = loaded;
  if (entry.developmentEntry === true && !DEV_TOOL_STAGES.includes(config.stage)) {
    process.stderr.write(
      formatProblems([
        {
          variable: 'STAGE',
          problem: `this is the development entry; it starts only on: ${DEV_TOOL_STAGES.join(', ')}`,
        },
      ]),
    );
    process.exitCode = EXIT_CODE.configuration;
    return undefined;
  }
  return config;
}
