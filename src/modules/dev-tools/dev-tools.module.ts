import { Module } from '@nestjs/common';
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
@Module({ controllers: [DevInfoController] })
export class DevToolsModule {}
