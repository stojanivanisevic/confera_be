import { Module } from '@nestjs/common';
import { ConferencesController } from './conferences.controller';
import { ConferencesService } from './conferences.service';

/** Conferences (FR-CONF-01 to 04). */
@Module({ controllers: [ConferencesController], providers: [ConferencesService] })
export class ConferencesModule {}
