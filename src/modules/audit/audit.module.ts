import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { SecuritySummary } from './security-summary';

/** The audit log and the summary of security events (FR-AUD-01 to 03). */
@Module({
  controllers: [AuditController],
  providers: [SecuritySummary],
  exports: [SecuritySummary],
})
export class AuditModule {}
