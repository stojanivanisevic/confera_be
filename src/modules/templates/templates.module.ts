import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { StatusEmailsController, TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/** Email templates (ADR-12): read in 0.2.0, managed from 0.4.0 (M4-BE-03). */
@Module({
  imports: [FilesModule],
  controllers: [TemplatesController, StatusEmailsController],
  providers: [TemplatesService],
})
export class TemplatesModule {}
