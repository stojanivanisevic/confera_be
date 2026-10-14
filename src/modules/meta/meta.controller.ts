import { Get } from '@nestjs/common';
import { AdminController } from '../../common/http/surface';
import { APP_VERSION, SERVICE_NAME } from '../../common/version';
import { Public } from '../access/access.decorators';
import { MetaDto } from './meta.dto';

// The admin shell reads the version at start, before anyone is signed in, and stops on a
// major-version mismatch (ADR-19): public, on the admin host name.
@AdminController('meta')
@Public()
export class MetaController {
  /** Name and version of the API. */
  @Get()
  getMeta(): MetaDto {
    return { name: SERVICE_NAME, version: APP_VERSION };
  }
}
