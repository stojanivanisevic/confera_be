import 'reflect-metadata';
import { type ModuleMetadata } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { refusePreflight } from './common/http/no-preflight.middleware';
import { type AppConfig, formatProblems } from './config/config';
import { loadConfig } from './config/env';
import { DEV_TOOL_STAGES } from './config/stage-guard';

/** Exit codes of a refused start, so that a script or a test can tell the reasons apart. */
export const EXIT_CODE = {
  /** The configuration is missing or invalid (EX_CONFIG of sysexits.h). */
  configuration: 78,
  /** Anything else that stopped the start. */
  failure: 1,
} as const;

export interface AppOptions {
  readonly extraImports?: NonNullable<ModuleMetadata['imports']>;
}

export interface StartOptions extends AppOptions {
  /** Set by the development entry only. Such a process refuses to run outside local and dev. */
  readonly developmentEntry?: boolean;
}

/** Builds the configured application without listening. Used by both entries and by tests. */
export async function createApp(
  config: AppConfig,
  options: AppOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, options.extraImports),
    { abortOnError: false },
  );
  app.disable('x-powered-by');
  app.use(refusePreflight);
  return app;
}

/** Reads the environment, refuses to start on a bad configuration, then listens. */
export async function start(options: StartOptions = {}): Promise<void> {
  const loaded = loadConfig();
  if (!loaded.ok) {
    process.stderr.write(formatProblems(loaded.problems));
    process.exitCode = EXIT_CODE.configuration;
    return;
  }
  const { config } = loaded;
  if (options.developmentEntry === true && !DEV_TOOL_STAGES.includes(config.stage)) {
    process.stderr.write(
      formatProblems([
        {
          variable: 'STAGE',
          problem: `this is the development entry; it starts only on: ${DEV_TOOL_STAGES.join(', ')}`,
        },
      ]),
    );
    process.exitCode = EXIT_CODE.configuration;
    return;
  }
  try {
    const app = await createApp(config, options);
    app.enableShutdownHooks();
    await app.listen(config.http.port, config.http.listenHost);
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error';
    process.stderr.write(`Confera API did not start: ${reason}.\n`);
    process.exitCode = EXIT_CODE.failure;
  }
}
