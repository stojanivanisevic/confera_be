import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { FileStorage } from '../files/storage';
import { type LinkPurpose, SecureLinks } from '../links/secure-links';
import { chooseServers } from '../mail-servers/mail-server-policy';
import type { Language } from '../templates/placeholders';
import { type Rendered, RenderError } from '../templates/render';
import { changedSince, linkRequestedAt } from './link-staleness';
import { composeMessage, contentIdOf, LINK_SENTINEL, withLink } from './mail-composer';
import { type DeliveryError, type InlineImage, MailTransport } from './mail-transport';
import { SecretBox } from './secret-box';

/**
 * Sends one message of the outbox (ADR-13, FR-SMTP-02, FR-SMTP-04):
 *
 * - the content composed when it was queued (mail-composer.ts, M2-ISS-05), or, for a
 *   message that had no template then, composed now by the same rules;
 * - the servers in the order of FR-SMTP-02, the fallback after a failure, each attempt in
 *   the mail log;
 * - its secure link made now, at send time, and never stored: the log shows `[link]`;
 * - its images as inline parts, read from the private storage now (M4-BE-06);
 * - the log keeps the subject and body only while the organisation's setting says so.
 *
 * Runs inside the organisation of the message (the worker enters it).
 */
export const LINK_MARK = '[link]';

/** Where a link leads in the web application. */
const LINK_PATHS: Readonly<Record<LinkPurpose, string>> = {
  invitation: 'invitations',
  password_reset: 'password-resets',
  email_change: 'email-changes',
};

/** Attempts of one message before it is marked failed. */
export const MAX_ATTEMPTS = 5;

/** The wait before the next attempt, after 1, 2, 3, 4 failed attempts. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

/** How long a message waits when nothing can send it now (no template, no server, rate). */
const WAIT_MS: Readonly<Record<WaitReason, number>> = {
  no_template: 5 * 60_000,
  no_mail_server: 5 * 60_000,
  rate_limited: 15_000,
};

/** The images of one message may weigh this much together (ADR-12, P: 1 MB). */
export const MESSAGE_IMAGES_LIMIT_BYTES = 1024 * 1024;

export type WaitReason = 'no_template' | 'no_mail_server' | 'rate_limited';

export type SendOutcome =
  | { readonly status: 'sent'; readonly serverId: string }
  | { readonly status: 'queued' | 'failed'; readonly error: DeliveryError }
  | { readonly status: 'waiting'; readonly reason: WaitReason };

type MessageRow = Prisma.MailMessageGetPayload<object>;
type ServerRow = Prisma.MailServerGetPayload<object>;

interface Prepared {
  readonly language: Language;
  /** The rendering with the link mark still in it. */
  readonly rendered: Rendered;
  readonly templateServerId: string | null;
  readonly conferenceServerId: string | null;
  readonly imageIds: readonly string[];
  readonly servers: ServerRow[];
  readonly logContent: boolean;
  /** Reply-To (UX4-06): the organisation's contact address for a mail to an author. */
  readonly replyTo: string | null;
}

@Injectable()
export class MailSender {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: TenantDatabase,
    private readonly context: TenantContext,
    private readonly links: SecureLinks,
    private readonly box: SecretBox,
    private readonly transport: MailTransport,
    private readonly storage: FileStorage,
  ) {}

  /** Sends a message the worker has claimed (status `sending`), and settles its row. */
  async send(messageId: string, now = new Date()): Promise<SendOutcome> {
    const message = await this.database.db.mailMessage.findUniqueOrThrow({
      where: { id: messageId },
    });
    const stale = await this.noLongerTrue(message);
    if (stale !== null) {
      // The account changed since the message was queued: no link is made, nothing is sent.
      await this.database.db.mailMessage.update({
        where: { id: message.id },
        data: { status: 'failed', lastErrorCode: stale, claimedAt: null },
      });
      return { status: 'failed', error: 'send_failed' };
    }
    const prepared = await this.prepare(message);
    if ('reason' in prepared) {
      return this.wait(message, prepared.reason, now);
    }
    const chosen = chooseServers(prepared.servers, {
      templateServerId: prepared.templateServerId,
      conferenceServerId: prepared.conferenceServerId,
    });
    if (chosen.length === 0) {
      return this.wait(message, 'no_mail_server', now);
    }
    const servers = [];
    for (const server of chosen) {
      if (!(await this.overRate(server, now))) {
        servers.push(server);
      }
    }
    if (servers.length === 0) {
      return this.wait(message, 'rate_limited', now);
    }

    const link = await this.mintLink(message, now);
    if (link === undefined && prepared.rendered.html.includes(LINK_SENTINEL)) {
      throw new RenderError('missing_link');
    }
    const images = await this.imagesOf(prepared.imageIds);
    const rendered = withLink(prepared.rendered, link ?? '');
    const logged = withLink(prepared.rendered, LINK_MARK);

    const attempt = message.attempts + 1;
    let error: DeliveryError = 'send_failed';
    for (const server of servers) {
      const result = await this.deliverAndLog(
        message,
        server,
        { ...rendered, images },
        logged,
        attempt,
        prepared,
      );
      if (result.ok) {
        await this.database.db.mailMessage.update({
          where: { id: message.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            attempts: attempt,
            lastErrorCode: null,
            claimedAt: null,
            // Without content in the log the outbox keeps none either (FR-SMTP-04).
            ...(prepared.logContent
              ? {}
              : { renderedSubject: null, renderedHtml: null, renderedText: null }),
          },
        });
        return { status: 'sent', serverId: server.id };
      }
      error = result.error;
    }
    const failed = attempt >= MAX_ATTEMPTS;
    await this.database.db.mailMessage.update({
      where: { id: message.id },
      data: {
        status: failed ? 'failed' : 'queued',
        attempts: attempt,
        lastErrorCode: error,
        claimedAt: null,
        nextAttemptAt: new Date(
          now.getTime() + (BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1) ?? 0),
        ),
      },
    });
    return { status: failed ? 'failed' : 'queued', error };
  }

  /**
   * The test message of a mail server (FR-SMTP-01): sent at once through that one server,
   * logged like any message. The caller has checked the target's rules, the cap and the rate.
   */
  async sendTest(
    serverId: string,
    to: string,
    language: Language,
    actorUserId: string,
  ): Promise<{ ok: boolean; error?: DeliveryError }> {
    const organisationId = this.context.requireOrganisationId();
    const message = await this.database.db.mailMessage.create({
      data: {
        organisationId,
        uniqueKey: `test_message:${randomUUID()}`,
        kind: 'test_message',
        recipientAddress: to,
        recipientUserId: null,
        language,
        status: 'sending',
        claimedAt: new Date(),
        parameters: { serverId, requestedBy: actorUserId },
      },
    });
    const prepared = await this.prepare(message);
    const server = await this.database.db.mailServer.findUniqueOrThrow({ where: { id: serverId } });
    if ('reason' in prepared) {
      await this.database.db.mailMessage.update({
        where: { id: message.id },
        data: { status: 'failed', lastErrorCode: prepared.reason, claimedAt: null },
      });
      return { ok: false, error: 'send_failed' };
    }
    const images = await this.imagesOf(prepared.imageIds);
    const rendered = withLink(prepared.rendered, '');
    const result = await this.deliverAndLog(
      message,
      server,
      { ...rendered, images },
      rendered,
      1,
      prepared,
    );
    await this.database.db.mailMessage.update({
      where: { id: message.id },
      data: result.ok
        ? { status: 'sent', sentAt: new Date(), attempts: 1, claimedAt: null }
        : { status: 'failed', attempts: 1, lastErrorCode: result.error, claimedAt: null },
    });
    return result;
  }

  /**
   * Whether a message that carries a link is still true now (E2-04): the person still has
   * the address it goes to (an email change goes to the new address, which is not theirs
   * yet), and the account is still one that may get such a link (an invitation for an
   * invited account, a reset or an email change for an active one).
   */
  private async noLongerTrue(message: MessageRow): Promise<string | null> {
    if (message.linkPurpose === null || message.linkUserId === null) {
      return null;
    }
    const user = await this.database.db.user.findUnique({
      where: { id: message.linkUserId },
      select: { status: true, email: true, passwordChangedAt: true, emailChangedAt: true },
    });
    if (user === null) {
      return 'account_gone';
    }
    // A request made before the password or the address changed does not outlive it
    // (SEC-M2-01); a resend is judged by the time of the request it repeats (SEC-M4-02).
    if (
      changedSince(
        user,
        await linkRequestedAt(
          (id) =>
            this.database.db.mailMessage.findUnique({
              where: { id },
              select: { createdAt: true, resendOf: true },
            }),
          message,
        ),
      )
    ) {
      return 'superseded';
    }
    const wanted = message.linkPurpose === 'invitation' ? 'invited' : 'active';
    if (user.status !== wanted) {
      return 'account_changed';
    }
    const sameAddress = user.email.toLowerCase() === message.recipientAddress.toLowerCase();
    if (message.linkPurpose !== 'email_change' && !sameAddress) {
      return 'address_changed';
    }
    return null;
  }

  /** The content of a message (stored when it was queued, or composed now) and its servers. */
  private async prepare(message: MessageRow): Promise<Prepared | { reason: WaitReason }> {
    return this.database.transaction(async (tx) => {
      let content: {
        rendered: Rendered;
        templateServerId: string | null;
        imageIds: readonly string[];
      } | null = null;
      if (
        message.renderedSubject !== null &&
        message.renderedHtml !== null &&
        message.renderedText !== null
      ) {
        content = {
          rendered: {
            subject: message.renderedSubject,
            html: message.renderedHtml,
            text: message.renderedText,
          },
          templateServerId: message.templateServerId,
          imageIds: message.imageIds,
        };
      } else {
        const composed = await composeMessage(tx, message);
        if (composed !== null) {
          content = {
            rendered: composed,
            templateServerId: composed.templateServerId,
            imageIds: composed.imageIds,
          };
        }
      }
      if (content === null) {
        return { reason: 'no_template' as const };
      }
      const organisation = await tx.organisation.findUniqueOrThrow({
        where: { id: message.organisationId },
        select: { mailLogContent: true, contactEmail: true },
      });
      const conference =
        message.conferenceId === null
          ? null
          : await tx.conference.findUnique({
              where: { id: message.conferenceId },
              select: { mailServerId: true },
            });
      const servers = await tx.mailServer.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const language: Language = message.language === 'sr' ? 'sr' : 'en';
      return {
        language,
        ...content,
        conferenceServerId: conference?.mailServerId ?? null,
        servers,
        logContent: organisation.mailLogContent,
        // A mail to an author is answered to the office's contact address (D8, UX4-06).
        replyTo: message.kind.startsWith('submission_') ? organisation.contactEmail : null,
      };
    });
  }

  /**
   * The images of a message as inline parts (ADR-12, M4-BE-06): read from the private
   * storage now, never addressed from outside. An image that is no longer clean, or gone,
   * is left out; together they stay under 1 MB.
   */
  private async imagesOf(ids: readonly string[]): Promise<InlineImage[]> {
    if (ids.length === 0) {
      return [];
    }
    const files = await this.database.db.storedFile.findMany({
      where: { id: { in: [...ids] }, kind: 'email_image', scanState: 'clean' },
      select: { id: true, storageKey: true, detectedType: true, sizeBytes: true },
    });
    const images: InlineImage[] = [];
    let total = 0;
    for (const file of files) {
      total += file.sizeBytes;
      if (total > MESSAGE_IMAGES_LIMIT_BYTES) {
        break;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of this.storage.read(file.storageKey)) {
        chunks.push(chunk as Buffer);
      }
      images.push({
        cid: contentIdOf(file.id),
        filename: `image-${String(images.length + 1)}.${file.detectedType === 'jpeg' ? 'jpg' : 'png'}`,
        contentType: `image/${file.detectedType}`,
        content: Buffer.concat(chunks),
      });
    }
    return images;
  }

  /** Whether the server has sent its rate in the last minute (counted from the log). */
  private async overRate(server: ServerRow, now: Date): Promise<boolean> {
    const sent = await this.database.db.mailLogEntry.count({
      where: { mailServerId: server.id, sentAt: { gt: new Date(now.getTime() - 60_000) } },
    });
    return sent >= server.sendRatePerMinute;
  }

  private async mintLink(message: MessageRow, now: Date): Promise<string | undefined> {
    const userId = message.linkUserId;
    if (message.linkPurpose === null || userId === null) {
      return undefined;
    }
    const purpose = message.linkPurpose as LinkPurpose;
    const token = await this.database.transaction((tx) =>
      this.links.mint(
        tx,
        {
          organisationId: message.organisationId,
          purpose,
          userId,
          recipient: message.recipientAddress,
        },
        now,
      ),
    );
    return `${this.config.origins.admin}/${LINK_PATHS[purpose]}/${token}`;
  }

  private async deliverAndLog(
    message: MessageRow,
    server: ServerRow,
    rendered: Rendered & { images: readonly InlineImage[] },
    logged: Rendered,
    attempt: number,
    prepared: Pick<Prepared, 'language' | 'logContent' | 'imageIds' | 'replyTo'>,
  ): Promise<{ ok: true } | { ok: false; error: DeliveryError }> {
    let password: string | null = null;
    if (server.passwordSealed !== null) {
      password = this.box.open(server.passwordSealed, {
        table: 'mail_servers',
        rowId: server.id,
        field: 'password',
      });
    }
    const result = await this.transport.deliver(
      {
        host: server.host,
        port: server.port,
        tlsMode: server.tlsMode as 'implicit' | 'starttls' | 'none',
        username: server.username,
        password,
        fromAddress: server.fromAddress,
        fromName: server.fromName,
      },
      {
        to: message.recipientAddress,
        ...rendered,
        language: prepared.language,
        replyTo: prepared.replyTo,
      },
    );
    await this.database.db.mailLogEntry.create({
      data: {
        organisationId: message.organisationId,
        messageId: message.id,
        mailServerId: server.id,
        serverName: server.name,
        recipient: message.recipientAddress,
        kind: message.kind,
        language: prepared.language,
        conferenceId: message.conferenceId,
        attempt,
        result: result.ok ? 'sent' : 'failed',
        errorCode: result.ok ? null : result.error,
        subject: prepared.logContent ? logged.subject : null,
        bodyHtml: prepared.logContent ? logged.html : null,
        bodyText: prepared.logContent ? logged.text : null,
        // The body and the ids of its images, not their bytes (ADR-13).
        imageIds: prepared.logContent ? [...prepared.imageIds] : [],
        diverted: this.transport.diverted,
      },
    });
    return result;
  }

  private async wait(message: MessageRow, reason: WaitReason, now: Date): Promise<SendOutcome> {
    await this.database.db.mailMessage.update({
      where: { id: message.id },
      data: {
        // Without a server the message rests until one is configured (UXUI-M2-01): the
        // mail servers wake it; its link is made when it is sent, so it lasts from then.
        status: reason === 'no_mail_server' ? 'waiting_for_server' : 'queued',
        claimedAt: null,
        lastErrorCode: reason,
        nextAttemptAt: new Date(now.getTime() + WAIT_MS[reason]),
      },
    });
    return { status: 'waiting', reason };
  }
}
