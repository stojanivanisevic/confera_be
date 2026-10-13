import { ApiSchema } from '@nestjs/swagger';

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
}
