import { Get, ServiceUnavailableException } from '@nestjs/common';
import { OpsController } from '../../common/http/surface';
import { Public } from '../access/access.decorators';
import { TenantDatabase } from '../../platform/prisma/tenant-database';

export interface HealthStatus {
  readonly status: 'ok';
}

@OpsController('health')
@Public()
export class HealthController {
  constructor(private readonly database: TenantDatabase) {}

  /**
   * Liveness: the process is up and answers. It touches nothing else, so it stays green
   * while a dependency is down; the container health check calls it.
   */
  @Get()
  live(): HealthStatus {
    return { status: 'ok' };
  }

  /** Readiness: the database answers too. 503 while it does not. */
  @Get('ready')
  async ready(): Promise<HealthStatus> {
    if (!(await this.database.isReachable())) {
      throw new ServiceUnavailableException();
    }
    return { status: 'ok' };
  }
}
