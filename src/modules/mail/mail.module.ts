import { Global, Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { MailSender } from './mail-sender';
import { MailTransport } from './mail-transport';
import { MailWorker } from './mail-worker';
import { SecretBox } from './secret-box';

/**
 * Sending (ADR-11, ADR-13): the secret box, the SMTP transport, the sender and the outbox
 * worker. Global, so that the mail servers and later modules use the same sender. The
 * outbox itself (MailQueue) is provided by the access module, which part A built on it.
 */
@Global()
@Module({
  // The private storage: the images of a message are read from it when it is sent.
  imports: [FilesModule],
  providers: [SecretBox, MailTransport, MailSender, MailWorker],
  exports: [SecretBox, MailTransport, MailSender, MailWorker],
})
export class MailModule {}
