import { Get, Inject } from '@nestjs/common';
import { OpsController } from '../../common/http/surface';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import { DEV_TOOLS_ROUTES } from './dev-tools.routes';

export interface DevInfo {
  readonly stage: string;
  readonly devTools: AppConfig['devTools'];
}

/** Says which development conveniences are switched on. Exists only in the development build. */
@OpsController(DEV_TOOLS_ROUTES.info)
export class DevInfoController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  info(): DevInfo {
    return { stage: this.config.stage, devTools: this.config.devTools };
  }
}
