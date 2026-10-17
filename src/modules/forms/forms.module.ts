import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { UploadsService } from '../files/uploads.service';
import { SendBreaker } from '../held-mail/send-breaker';
import { ConferenceFormsController, FormsController } from './forms.controller';
import { FormsService } from './forms.service';
import { IntakeService } from './intake.service';
import { NoPrototypeKeysGuard, OwnPageGuard } from './own-page.guard';
import { PublicFormsController } from './public-forms.controller';
import { PublicLimits } from './public-limits';

/**
 * Forms and intake (M3-BE-01 to 04): the admin's forms and versions, and the public API of
 * ADR-08 with its uploads.
 */
@Module({
  imports: [FilesModule],
  controllers: [FormsController, ConferenceFormsController, PublicFormsController],
  providers: [
    FormsService,
    IntakeService,
    PublicLimits,
    SendBreaker,
    UploadsService,
    OwnPageGuard,
    NoPrototypeKeysGuard,
  ],
})
export class FormsModule {}
