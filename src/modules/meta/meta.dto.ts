import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { INSTANCES } from '../../config/config.schema';

/** What the API is and which version of the contract it speaks. */
@ApiSchema({ name: 'Meta' })
export class MetaDto {
  /** Name of the service. */
  name!: string;

  /**
   * Version of the API (SemVer), the same as `info.version` of the OpenAPI document.
   * A client built for another major version must stop and ask for a reload.
   */
  version!: string;

  /**
   * `staging` on the staging server (every screen shows the staging banner, ADR-27),
   * `production` on production, null on a developer machine.
   */
  @ApiProperty({ enum: INSTANCES, nullable: true })
  instance!: (typeof INSTANCES)[number] | null;
}
