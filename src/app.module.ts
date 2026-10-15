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
import { AccessGuard } from './modules/access/access.guard';
import { AccessModule } from './modules/access/access.module';
import { AuditModule } from './modules/audit/audit.module';
import { ConferencesModule } from './modules/conferences/conferences.module';
import { CspReportsModule } from './modules/csp-reports/csp-reports.module';
import { HealthModule } from './modules/health/health.module';
import { MailModule } from './modules/mail/mail.module';
import { MailLogModule } from './modules/mail-log/mail-log.module';
import { MailServersModule } from './modules/mail-servers/mail-servers.module';
import { MetaModule } from './modules/meta/meta.module';
import { OrganisationModule } from './modules/organisation/organisation.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { UsersModule } from './modules/users/users.module';
import { PdfModule } from './platform/pdf/pdf.module';
import { PrismaModule } from './platform/prisma/prisma.module';

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
        PrismaModule,
        PdfModule,
        AccessModule,
        HealthModule,
        MetaModule,
        UsersModule,
        OrganisationModule,
        AuditModule,
        CspReportsModule,
        MailModule,
        MailServersModule,
        ConferencesModule,
        TemplatesModule,
        MailLogModule,
        ...extraImports,
      ],
      providers: [
        // One exception filter for everything that is thrown (ADR-19).
        { provide: APP_FILTER, useClass: ProblemFilter },
        // Host separation of the two surfaces, checked on every route (ADR-02); then who
        // may call the route (ADR-03, ADR-05). The order is the order of the guards here.
        { provide: APP_GUARD, useClass: SurfaceGuard },
        { provide: APP_GUARD, useExisting: AccessGuard },
        { provide: APP_PIPE, useFactory: createValidationPipe },
      ],
    };
  }
}
