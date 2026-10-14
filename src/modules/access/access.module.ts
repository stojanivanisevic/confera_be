import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AuditRecorder } from '../audit/audit-recorder';
import { SecureLinks } from '../links/secure-links';
import { MailQueue } from '../mail/mail-queue';
import { AccessGuard } from './access.guard';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { BrakeService } from './brake.service';
import { PasswordHasher } from './password-hasher';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { SignInService } from './sign-in.service';

/**
 * Sign-in, sessions, the own account and the secure links that act on it (ADR-03, ADR-04).
 * Global, so that the guard, the sessions, the audit recorder and the outbox are at hand
 * in every module.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [SessionController, AccountController],
  providers: [
    AccessGuard,
    AccountService,
    AuditRecorder,
    BrakeService,
    MailQueue,
    PasswordHasher,
    SecureLinks,
    SessionService,
    SignInService,
  ],
  exports: [AccessGuard, AuditRecorder, MailQueue, SecureLinks, SessionService, PasswordHasher],
})
export class AccessModule {}
