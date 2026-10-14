import { Module } from '@nestjs/common';
import { OrganisationController } from './organisation.controller';
import { OrganisationService } from './organisation.service';

/** The organisation profile (FR-ORG-01 to 03). */
@Module({ controllers: [OrganisationController], providers: [OrganisationService] })
export class OrganisationModule {}
