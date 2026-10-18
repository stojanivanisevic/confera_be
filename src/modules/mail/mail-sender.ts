import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { LINK_LIFETIME_MS, type LinkPurpose, SecureLinks } from '../links/secure-links';
import { chooseServers } from '../mail-servers/mail-server-policy';
import {
  catalogueOf,
  isTemplateType,
  type Language,
  type TemplateType,
} from '../templates/placeholders';
import { type Rendered, renderTemplate } from '../templates/render';
import { hasUrl } from '../forms/rules';
import { type DeliveryError, MailTransport } from './mail-transport';
import { SecretBox } from './secret-box';

/**
 * Renders and sends one message of the outbox (ADR-13, FR-SMTP-02, FR-SMTP-04):
 *
 * - the template of its type: of its conference in its language, of its conference in
 *   English, of the organisation in its language, of the organisation in English;
 * - the servers in the order of FR-SMTP-02, the fallback after a failure, each attempt in
 *   the mail log;
 * - its secure link made now, at send time, and never stored: the log shows `[link]`;
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

export type WaitReason = 'no_template' | 'no_mail_server' | 'rate_limited';

export type SendOutcome =
  | { readonly status: 'sent'; readonly serverId: string }
  | { readonly status: 'queued' | 'failed'; readonly error: DeliveryError }
  | { readonly status: 'waiting'; readonly reason: WaitReason };

/** What the change of a security notice is called in the message. */
const CHANGE_TEXT: Readonly<Record<string, Readonly<Record<Language, string>>>> = {
  user_invited: { en: 'a user was invited', sr: 'pozvan je korisnik' },
  user_changed: { en: 'a user was changed', sr: 'izmenjen je korisnik' },
  user_role_changed: { en: 'the role of a user was changed', sr: 'promenjena je uloga korisnika' },
  user_deactivated: { en: 'a user was deactivated', sr: 'korisnik je deaktiviran' },
  user_reactivated: { en: 'a user was reactivated', sr: 'korisnik je ponovo aktiviran' },
  user_removed: { en: 'a user was removed', sr: 'korisnik je uklonjen' },
  user_sessions_ended: {
    en: 'the sessions of a user were ended',
    sr: 'prekinute su sesije korisnika',
  },
  own_password_changed: { en: 'a user changed their password', sr: 'korisnik je promenio lozinku' },
  password_reset: { en: 'a password was reset', sr: 'lozinka je resetovana' },
  own_email_change_requested: {
    en: 'a user asked to change their email address',
    sr: 'korisnik je zatražio promenu adrese e-pošte',
  },
  organisation_payment_details_changed: {
    en: 'the payment details of the organisation were changed',
    sr: 'promenjeni su podaci za plaćanje organizacije',
  },
  new_device_sign_in: { en: 'a sign-in from a new device', sr: 'prijava sa novog uređaja' },
  mail_server_created: { en: 'a mail server was added', sr: 'dodat je server za poštu' },
  mail_server_changed: { en: 'a mail server was changed', sr: 'izmenjen je server za poštu' },
  mail_server_deleted: { en: 'a mail server was deleted', sr: 'obrisan je server za poštu' },
  mail_held: {
    en: 'the send breaker holds confirmation emails of a form; release them in the list of held emails',
    sr: 'prekidač slanja zadržava potvrde jednog obrasca; pustite ih u spisku zadržanih poruka',
  },
  upload_quota_reached: {
    en: 'the space for uploaded files that are not yet attached is full; uploads are refused',
    sr: 'prostor za otpremljene datoteke koje još nisu priložene je pun; otpremanje se odbija',
  },
  virus_scan_pending: {
    en: 'files wait for their virus scan because the antivirus does not answer',
    sr: 'datoteke čekaju proveru na viruse jer antivirus ne odgovara',
  },
};

/** The longest title a confirmation shows (FR-FORM-15: cut to its length). */
export const CONFIRMATION_TITLE_LENGTH = 200;

/**
 * A `label.tld` token (SEC-M3-03, M3-ISS-03): mail programs make a link of a bare domain
 * (`evil.com`, `x.com:8080/a`), which the form accepts because `ASP.NET` is a word. The
 * confirmation is stricter than the form: a false positive costs only the line of the title.
 */
const DOMAIN = /(^|[^\p{L}\p{N}@.-])[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/u;

/**
 * The title as a confirmation shows it (FR-FORM-15, SA-13, ST-35): one line, no control or
 * invisible character, cut to its length; and none at all when it holds an address or a bare
 * domain, which a mail program would make a link of (the form refuses an address; this holds
 * for a row planted past it).
 */
export function confirmationTitle(title: string | null): string | null {
  if (title === null) {
    return null;
  }
  const line = title
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (line === '' || hasUrl(line)) {
    return null;
  }
  let cut = '';
  let count = 0;
  for (const character of line) {
    if (count === CONFIRMATION_TITLE_LENGTH) {
      cut = `${cut.trimEnd()}…`;
      break;
    }
    cut += character;
    count += 1;
  }
  // Judged on what the mail would show: at most 201 characters, so the match stays cheap.
  return DOMAIN.test(cut) ? null : cut;
}

function lifetimeText(ms: number, language: Language): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return language === 'sr' ? `${String(hours)} sata` : `${String(hours)} hours`;
  }
  return language === 'sr' ? `${String(minutes)} minuta` : `${String(minutes)} minutes`;
}

type MessageRow = Prisma.MailMessageGetPayload<object>;
type ServerRow = Prisma.MailServerGetPayload<object>;

interface Prepared {
  readonly type: TemplateType;
  readonly language: Language;
  readonly stored: { subject: unknown; body: unknown; mailServerId: string | null };
  readonly values: Record<string, string>;
  readonly conditions: Set<string>;
  readonly servers: ServerRow[];
  readonly logContent: boolean;
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
      templateServerId: prepared.stored.mailServerId,
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
    const input = { values: prepared.values, conditions: prepared.conditions };
    const rendered = renderTemplate(prepared.stored, catalogueOf(prepared.type), {
      ...input,
      link,
    });
    const logged = renderTemplate(prepared.stored, catalogueOf(prepared.type), {
      ...input,
      link: link === undefined ? undefined : LINK_MARK,
    });

    const attempt = message.attempts + 1;
    let error: DeliveryError = 'send_failed';
    for (const server of servers) {
      const result = await this.deliverAndLog(message, server, rendered, logged, attempt, prepared);
      if (result.ok) {
        await this.database.db.mailMessage.update({
          where: { id: message.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            attempts: attempt,
            lastErrorCode: null,
            claimedAt: null,
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
   * logged like any message. The caller has checked the target's rules.
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
    const rendered = renderTemplate(prepared.stored, catalogueOf('test_message'), {
      values: prepared.values,
      conditions: prepared.conditions,
    });
    const result = await this.deliverAndLog(message, server, rendered, rendered, 1, prepared);
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
      select: { status: true, email: true, passwordChangedAt: true },
    });
    if (user === null) {
      return 'account_gone';
    }
    // A request made before the password changed does not outlive it (SEC-M2-01).
    if (
      user.passwordChangedAt !== null &&
      message.createdAt.getTime() < user.passwordChangedAt.getTime()
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

  private async prepare(
    message: MessageRow,
  ): Promise<(Prepared & { conferenceServerId: string | null }) | { reason: WaitReason }> {
    if (!isTemplateType(message.kind)) {
      return { reason: 'no_template' };
    }
    const type = message.kind;
    const language: Language = message.language === 'sr' ? 'sr' : 'en';
    return this.database.transaction(async (tx) => {
      const template = await this.findTemplate(tx, type, language, message.conferenceId);
      if (template === null) {
        return { reason: 'no_template' as const };
      }
      const organisation = await tx.organisation.findUniqueOrThrow({
        where: { id: message.organisationId },
        select: { name: true, mailLogContent: true },
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
      const { values, conditions } = await this.valuesOf(
        tx,
        message,
        type,
        language,
        organisation.name,
      );
      return {
        type,
        language,
        stored: {
          subject: template.subject,
          body: template.body,
          mailServerId: template.mailServerId,
        },
        values,
        conditions,
        servers,
        logContent: organisation.mailLogContent,
        conferenceServerId: conference?.mailServerId ?? null,
      };
    });
  }

  private async findTemplate(
    tx: Prisma.TransactionClient,
    type: TemplateType,
    language: Language,
    conferenceId: string | null,
  ) {
    const order: { conferenceId: string | null; language: Language }[] = [];
    if (conferenceId !== null) {
      order.push({ conferenceId, language }, { conferenceId, language: 'en' });
    }
    order.push({ conferenceId: null, language }, { conferenceId: null, language: 'en' });
    for (const where of order) {
      const template = await tx.mailTemplate.findFirst({
        where: { type, language: where.language, conferenceId: where.conferenceId },
        select: { subject: true, body: true, mailServerId: true },
      });
      if (template !== null) {
        return template;
      }
    }
    return null;
  }

  /** The placeholder values of a message: names looked up now, never stored in the outbox. */
  private async valuesOf(
    tx: Prisma.TransactionClient,
    message: MessageRow,
    type: TemplateType,
    language: Language,
    organisationName: string,
  ): Promise<{ values: Record<string, string>; conditions: Set<string> }> {
    const parameters = (message.parameters ?? {}) as Record<string, unknown>;
    const nameOf = async (id: unknown): Promise<string | null> => {
      if (typeof id !== 'string') {
        return null;
      }
      const user = await tx.user.findUnique({ where: { id }, select: { displayName: true } });
      return user?.displayName ?? null;
    };
    const recipientName = (await nameOf(message.recipientUserId)) ?? message.recipientAddress;
    const values: Record<string, string> = { recipientName, organisationName };
    const conditions = new Set<string>();
    if (message.linkPurpose !== null) {
      values.expiresIn = lifetimeText(
        LINK_LIFETIME_MS[message.linkPurpose as LinkPurpose],
        language,
      );
    }
    switch (type) {
      case 'invitation':
        values.inviterName = (await nameOf(parameters.invitedBy)) ?? organisationName;
        break;
      case 'email_change_confirmation':
        values.newEmail = message.recipientAddress;
        break;
      case 'email_change_notice': {
        // The new address is the recipient of the confirmation queued with this notice.
        const sibling = await tx.mailMessage.findFirst({
          where: {
            uniqueKey: message.uniqueKey.replace(
              /^email_change_notice:/,
              'email_change_confirmation:',
            ),
          },
          select: { recipientAddress: true },
        });
        values.newEmail = sibling?.recipientAddress ?? '';
        break;
      }
      case 'security_notice': {
        const change = typeof parameters.change === 'string' ? parameters.change : '';
        values.change = CHANGE_TEXT[change]?.[language] ?? change;
        const actor = await nameOf(parameters.actorUserId);
        const subject = await nameOf(parameters.subjectUserId);
        values.actorName = actor ?? '';
        values.subjectName = subject ?? '';
        if (actor !== null) {
          conditions.add('hasActor');
        }
        if (subject !== null) {
          conditions.add('hasSubject');
        }
        break;
      }
      case 'submission_confirmation': {
        const submission =
          typeof parameters.submissionId === 'string'
            ? await tx.submission.findUnique({
                where: { id: parameters.submissionId },
                select: { reference: true, title: true, conference: { select: { name: true } } },
              })
            : null;
        values.reference = submission?.reference ?? '';
        values.conferenceName = submission?.conference.name ?? '';
        const title = confirmationTitle(submission?.title ?? null);
        values.title = title ?? '';
        if (title !== null) {
          conditions.add('hasTitle');
        }
        // The address is the author's own text: it never becomes a name in the message.
        values.recipientName = '';
        break;
      }
      case 'test_message': {
        const server =
          typeof parameters.serverId === 'string'
            ? await tx.mailServer.findUnique({
                where: { id: parameters.serverId },
                select: { name: true },
              })
            : null;
        values.serverName = server?.name ?? '';
        break;
      }
      default:
        break;
    }
    return { values, conditions };
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
    rendered: Rendered,
    logged: Rendered,
    attempt: number,
    prepared: Pick<Prepared, 'language' | 'logContent'>,
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
      { to: message.recipientAddress, ...rendered },
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
