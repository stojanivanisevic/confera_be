import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE, DiscoveryModule } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ProblemFilter } from './common/http/problem.filter';
import { SurfaceGuard } from './common/http/surface';
import { createValidationPipe } from './common/http/validation';
import type { AppLogger } from './common/logging/app-logger';
import { LoggingModule } from './common/logging/logging.module';
import type { AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './modules/health/health.module';
import { MetaModule } from './modules/meta/meta.module';

type Imports = NonNullable<ModuleMetadata['imports']>;

export interface AppModuleOptions {
  readonly config: AppConfig;
  readonly logger: AppLogger;
  /**
   * How the development entry adds the dev-tools module. The production entry passes
   * nothing, and the production build does not contain that module at all.
   */
  readonly extraImports?: Imports;
}

@Module({})
export class AppModule {
  /**
   * The application is assembled from an already validated configuration, so tests and
   * tools can build it without touching the environment.
   */
  static register({ config, logger, extraImports = [] }: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        LoggingModule.register(logger),
        // The request context (trace id, later the organisation). Its middleware is mounted
        // in bootstrap.ts, first in the chain.
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        DiscoveryModule,
        HealthModule,
        MetaModule,
        ...extraImports,
      ],
      providers: [
        // One exception filter for everything that is thrown (ADR-19).
        { provide: APP_FILTER, useClass: ProblemFilter },
        // Host separation of the two surfaces, checked on every route (ADR-02).
        { provide: APP_GUARD, useClass: SurfaceGuard },
        { provide: APP_PIPE, useFactory: createValidationPipe },
      ],
    };
  }
}
