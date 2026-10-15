import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';

/** Email templates, read only in 0.2.0 (ADR-12). */
@Module({ controllers: [TemplatesController] })
export class TemplatesModule {}
