import { Controller, Get } from '@nestjs/common';

export interface HealthStatus {
  readonly status: 'ok';
}

/**
 * Liveness: the process is up and answers. It touches nothing else, so it stays green
 * while a dependency is down; the proxy and the container health check call it.
 */
@Controller('health')
export class HealthController {
  @Get()
  live(): HealthStatus {
    return { status: 'ok' };
  }
}
