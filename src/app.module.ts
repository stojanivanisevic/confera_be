import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import type { AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './modules/health/health.module';

type Imports = NonNullable<ModuleMetadata['imports']>;

@Module({})
export class AppModule {
  /**
   * The application is assembled from an already validated configuration, so tests and
   * tools can build it without touching the environment.
   *
   * `extraImports` is how the development entry adds the dev-tools module. The production
   * entry passes nothing, and the production build does not contain that module at all.
   */
  static register(config: AppConfig, extraImports: Imports = []): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.register(config), HealthModule, ...extraImports],
    };
  }
}
