import { Module } from '@nestjs/common';
import { CspReportsController } from './csp-reports.controller';

/** The reports of the web application's content security policy (M1-ISS-11). */
@Module({ controllers: [CspReportsController] })
export class CspReportsModule {}
