import { Global, Module } from '@nestjs/common';
import { AppLogger } from '../../common/logging/app-logger';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import type { QueryObserver } from '../../platform/prisma/tenant-client';
import { QUERY_OBSERVER } from '../../platform/prisma/tenant-database';
import { DevInfoController } from './dev-info.controller';

/**
 * Development conveniences (ADR-24): absent from the production build, not switched off.
 *
 * - Nothing outside this folder imports from it. The only way in is the development
 *   entry, main.dev.ts, which lives here too.
 * - tsconfig.build.json leaves this folder out, so `pnpm build` (dist/) does not contain
 *   it; a test of the built application asserts that (ST-02).
 * - Each convenience is behind its own `DEV_*` variable, which the configuration guard
 *   accepts only on STAGE=local or dev.
 */
@Global()
@Module({
  controllers: [DevInfoController],
  providers: [
    {
      // DEV_LOG_QUERIES: every SQL statement goes to the log, without its parameter values.
      provide: QUERY_OBSERVER,
      inject: [APP_CONFIG, AppLogger],
      useFactory: (config: AppConfig, logger: AppLogger): QueryObserver | undefined =>
        config.devTools.logQueries
          ? (event) => {
              logger.info('db.query', { ...event });
            }
          : undefined,
    },
  ],
  exports: [QUERY_OBSERVER],
})
export class DevToolsModule {}
