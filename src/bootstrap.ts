import 'reflect-metadata';
import { type ModuleMetadata } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { DestinationStream } from 'pino';
import { AppModule } from './app.module';
import { refusePreflight } from './common/http/no-preflight.middleware';
import { securityHeaders } from './common/http/security-headers';
import { requestContext } from './common/http/trace';
import { AppLogger, createRootLogger } from './common/logging/app-logger';
import { requestLog } from './common/logging/request-log.middleware';
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
  /** Called with the application before it starts to listen. The development entry uses it. */
  readonly configure?: (app: NestExpressApplication, config: AppConfig) => void | Promise<void>;
  /** Where the log goes. Default: stdout. Tests pass a stream they can read. */
  readonly logDestination?: DestinationStream;
}

export interface StartOptions extends AppOptions {
  /** Set by the development entry only. Such a process refuses to run outside local and dev. */
  readonly developmentEntry?: boolean;
}

/**
 * Builds the configured application without listening. Used by both entries, by the
 * OpenAPI generator and by tests, so that all of them run the same middleware and filter.
 */
export async function createApp(
  config: AppConfig,
  options: AppOptions = {},
): Promise<NestExpressApplication> {
  const logger = new AppLogger(createRootLogger(config.logLevel, options.logDestination));
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register({ config, logger, extraImports: options.extraImports }),
    { abortOnError: false, logger },
  );
  app.disable('x-powered-by');
  // Order matters: the request context first, so that everything after it has a trace id.
  app.use(requestContext());
  app.use(securityHeaders);
  app.use(requestLog(logger));
  app.use(refusePreflight);
  await options.configure?.(app, config);
  return app;
}

function refuse(variable: string, problem: string): void {
  process.stderr.write(formatProblems([{ variable, problem }]));
  process.exitCode = EXIT_CODE.configuration;
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
    refuse(
      'STAGE',
      `this is the development entry; it starts only on: ${DEV_TOOL_STAGES.join(', ')}`,
    );
    return;
  }
  try {
    const app = await createApp(config, options);
    app.enableShutdownHooks();
    await app.listen(config.http.port, config.http.listenHost);
    app.get(AppLogger).info('api.started', {
      stage: config.stage,
      instance: config.instance,
      port: config.http.port,
    });
  } catch (error) {
    // The reason is named by its kind only: a message can hold an address or a value.
    const reason = error instanceof Error ? error.name : 'unknown error';
    process.stderr.write(`Confera API did not start: ${reason}.\n`);
    process.exitCode = EXIT_CODE.failure;
  }
}
