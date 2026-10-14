import 'reflect-metadata';
import { type ModuleMetadata } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { DestinationStream } from 'pino';
import { AppModule } from './app.module';
import { bodyLimit } from './common/http/body-limit';
import { TRUSTED_PROXY_HOPS } from './common/http/client-address';
import {
  CSP_REPORT_BODY_LIMIT,
  CSP_REPORT_PATH,
} from './modules/csp-reports/csp-reports.controller';
import { refusePreflight } from './common/http/no-preflight.middleware';
import { securityHeaders } from './common/http/security-headers';
import { requestContext } from './common/http/trace';
import { AppLogger, createRootLogger } from './common/logging/app-logger';
import { requestLog } from './common/logging/request-log.middleware';
import { StartupRefusal } from './common/startup-refusal';
import type { AppConfig } from './config/config';
import { EXIT_CODE } from './startup';

export { EXIT_CODE };

export interface AppOptions {
  readonly extraImports?: NonNullable<ModuleMetadata['imports']>;
  /** Called with the application before it starts to listen. The development entry uses it. */
  readonly configure?: (app: NestExpressApplication, config: AppConfig) => void | Promise<void>;
  /** Where the log goes. Default: stdout. Tests pass a stream they can read. */
  readonly logDestination?: DestinationStream;
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
    // bodyParser: false, so that configureHttp sets the limits and content types itself.
    { abortOnError: false, logger, bodyParser: false },
  );
  configureHttp(app, logger);
  await options.configure?.(app, config);
  return app;
}

/** The largest JSON body of an ordinary request (ST-41 caps it; the forms of 0.3.0 raise it where needed). */
export const JSON_BODY_LIMIT = '64kb';

/** The middleware of every request, in order. Tests apply it to their own application too. */
export function configureHttp(app: NestExpressApplication, logger: AppLogger): void {
  app.disable('x-powered-by');
  // The one hop in front of the API that may write X-Forwarded-For (ADR-03, ST-25).
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
  // Order matters: the request context first, so that everything after it has a trace id.
  app.use(requestContext());
  app.use(securityHeaders);
  app.use(requestLog(logger));
  app.use(refusePreflight);
  // Bodies: JSON of a bounded size, and nothing else. A browser posts the reports of the
  // content security policy as application/csp-report or application/reports+json, with
  // a limit of their own, smaller than the general one.
  app.use(CSP_REPORT_PATH, bodyLimit(CSP_REPORT_BODY_LIMIT));
  app.useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
    type: ['application/json', 'application/csp-report', 'application/reports+json'],
  });
}

/**
 * Builds the application and listens. The configuration was read and accepted by the
 * entry before this file was loaded (`configurationOrRefusal` of src/startup.ts).
 */
export async function start(config: AppConfig, options: AppOptions = {}): Promise<void> {
  let app: NestExpressApplication | undefined;
  try {
    app = await createApp(config, options);
    app.enableShutdownHooks();
    await app.listen(config.http.port, config.http.listenHost);
    app.get(AppLogger).info('api.started', {
      stage: config.stage,
      instance: config.instance,
      port: config.http.port,
    });
  } catch (error) {
    if (error instanceof StartupRefusal) {
      // A sentence written by us: safe to print.
      process.stderr.write(`Confera API did not start: ${error.reason}
`);
      process.exitCode = EXIT_CODE.refused;
    } else {
      // Named by its kind only: a message can hold an address or a value.
      const kind = error instanceof Error ? error.name : 'unknown error';
      process.stderr.write(`Confera API did not start: ${kind}.
`);
      process.exitCode = EXIT_CODE.failure;
    }
    // Close what was opened (the database pools), so that the process ends by itself;
    // and end it anyway if closing hangs. The timer does not keep the process alive.
    setTimeout(() => process.exit(), 3000).unref();
    await app?.close().catch(() => undefined);
  }
}
