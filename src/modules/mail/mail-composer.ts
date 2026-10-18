import type { Prisma } from '../../generated/prisma/client';
import { hasUrl } from '../forms/rules';
import { LINK_LIFETIME_MS, type LinkPurpose } from '../links/secure-links';
import { checkBody, imagesOf } from '../templates/document';
import {
  catalogueOf,
  isTemplateType,
  type Language,
  type TemplateType,
} from '../templates/placeholders';
import { type Rendered, type RenderedImage, renderTemplate } from '../templates/render';

/**
 * The composition of a message (ADR-12, ADR-13): its template by the fallback order, the
 * values of its placeholders, and the rendering. Done when the message is QUEUED, in the
 * transaction of the change that causes it (M2-ISS-05), so that what an admin was shown
 * (FR-MAIL-08) is what is sent; done at send time only for a message that had no template
 * when it was queued. The same composition makes the preview (FR-MAIL-08, FR-MAIL-02).
 *
 * The secure link is never in the stored text: the link node's address is `LINK_SENTINEL`,
 * a mark no text of a template or value can hold (a control character), replaced at send
 * time by a fresh link and in the log by `[link]`.
 */
export const LINK_SENTINEL = `${String.fromCharCode(1)}link${String.fromCharCode(1)}`;

/** The content id of an email image inside a message (an inline part, ADR-12). */
export function contentIdOf(fileId: string): string {
  return `${fileId}@confera`;
}

/** What a message is, as far as its composition needs it: a row of the outbox, or one about to be. */
export interface ComposeInput {
  readonly organisationId: string;
  readonly kind: string;
  readonly language: string;
  readonly conferenceId: string | null;
  readonly recipientUserId: string | null;
  readonly recipientAddress: string;
  readonly linkPurpose: string | null;
  readonly uniqueKey: string;
  readonly parameters: unknown;
}

export interface Composed extends Rendered {
  readonly type: TemplateType;
  readonly language: Language;
  /** The mail server of the template, first in the order of FR-SMTP-02. */
  readonly templateServerId: string | null;
  /** The images shown in the message, by file id (each an inline part when sent). */
  readonly imageIds: readonly string[];
}

/** How the images of a composition are addressed: inline parts, or data for the preview. */
export type ImageAddressing =
  | { readonly kind: 'cid' }
  | { readonly kind: 'data'; readonly read: (storageKey: string) => Promise<Buffer> };

export interface ComposeOptions {
  /** The admin's text for the author, before it is in the history (the preview). */
  readonly message?: string | null | undefined;
  readonly images?: ImageAddressing;
}

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
 * The title as a confirmation or a status email shows it (FR-FORM-15, SA-13, ST-35, ST-44):
 * one line, no control or invisible character, cut to its length; and none at all when it
 * holds an address or a bare domain, which a mail program would make a link of (the form
 * refuses an address; this holds for a row planted past it, and for a correction).
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

/** The template of a type by the fallback order of ADR-12: conference and language first. */
export async function findTemplate(
  tx: Prisma.TransactionClient,
  type: TemplateType,
  language: Language,
  conferenceId: string | null,
): Promise<{ id: string; subject: unknown; body: unknown; mailServerId: string | null } | null> {
  const order: { conferenceId: string | null; language: Language }[] = [];
  if (conferenceId !== null) {
    order.push({ conferenceId, language }, { conferenceId, language: 'en' });
  }
  order.push({ conferenceId: null, language }, { conferenceId: null, language: 'en' });
  for (const where of order) {
    const template = await tx.mailTemplate.findFirst({
      where: { type, language: where.language, conferenceId: where.conferenceId },
      select: { id: true, subject: true, body: true, mailServerId: true },
    });
    if (template !== null) {
      return template;
    }
  }
  return null;
}

/** The placeholder values of a message: names looked up now, never stored in the outbox. */
async function valuesOf(
  tx: Prisma.TransactionClient,
  input: ComposeInput,
  type: TemplateType,
  language: Language,
  organisationName: string,
  options: ComposeOptions,
): Promise<{ values: Record<string, string>; conditions: Set<string> }> {
  const parameters = (input.parameters ?? {}) as Record<string, unknown>;
  const nameOf = async (id: unknown): Promise<string | null> => {
    if (typeof id !== 'string') {
      return null;
    }
    const user = await tx.user.findUnique({ where: { id }, select: { displayName: true } });
    return user?.displayName ?? null;
  };
  const recipientName = (await nameOf(input.recipientUserId)) ?? input.recipientAddress;
  const values: Record<string, string> = { recipientName, organisationName };
  const conditions = new Set<string>();
  if (input.linkPurpose !== null) {
    values.expiresIn = lifetimeText(LINK_LIFETIME_MS[input.linkPurpose as LinkPurpose], language);
  }
  const submissionOf = (id: unknown) =>
    typeof id === 'string'
      ? tx.submission.findUnique({
          where: { id },
          select: {
            reference: true,
            title: true,
            firstAuthorName: true,
            conference: { select: { name: true } },
          },
        })
      : Promise.resolve(null);
  switch (type) {
    case 'invitation':
      values.inviterName = (await nameOf(parameters.invitedBy)) ?? organisationName;
      break;
    case 'email_change_confirmation':
      values.newEmail = input.recipientAddress;
      break;
    case 'email_change_notice': {
      // The new address is the recipient of the confirmation queued with this notice.
      const sibling = await tx.mailMessage.findFirst({
        where: {
          uniqueKey: input.uniqueKey.replace(/^email_change_notice:/, 'email_change_confirmation:'),
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
      const submission = await submissionOf(parameters.submissionId);
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
    case 'submission_opened':
    case 'submission_returned':
    case 'submission_resumed':
    case 'submission_accepted':
    case 'submission_rejected':
    case 'submission_withdrawn':
    case 'submission_reopened': {
      // A status email (FR-MAIL-05): the admin's text comes from the history row of the
      // change, or, for the preview, from the request; never from the outbox row.
      const submission = await submissionOf(parameters.submissionId);
      values.reference = submission?.reference ?? '';
      values.conferenceName = submission?.conference.name ?? '';
      values.authorName = submission?.firstAuthorName ?? '';
      const title = confirmationTitle(submission?.title ?? null);
      values.title = title ?? '';
      if (title !== null) {
        conditions.add('hasTitle');
      }
      let message = options.message ?? null;
      if (message === null && typeof parameters.historyId === 'string') {
        const history = await tx.submissionStatusChange.findUnique({
          where: { id: parameters.historyId },
          select: { message: true },
        });
        message = history?.message ?? null;
      }
      values.message = message ?? '';
      if (message !== null && message.trim() !== '') {
        conditions.add('hasMessage');
      }
      break;
    }
    default:
      break;
  }
  return { values, conditions };
}

/** The images a body may show now (scanned clean, of this organisation), addressed as asked. */
async function imagesFor(
  tx: Prisma.TransactionClient,
  body: unknown,
  type: TemplateType,
  addressing: ImageAddressing,
): Promise<Map<string, RenderedImage>> {
  const shown = new Map<string, RenderedImage>();
  const ids = imagesOf(checkBody(body, catalogueOf(type)));
  if (ids.length === 0) {
    return shown;
  }
  const files = await tx.storedFile.findMany({
    where: { id: { in: ids }, kind: 'email_image', scanState: 'clean' },
    select: {
      id: true,
      storageKey: true,
      detectedType: true,
      width: true,
      height: true,
    },
  });
  for (const file of files) {
    if (file.width === null || file.height === null) {
      continue;
    }
    const src =
      addressing.kind === 'cid'
        ? `cid:${contentIdOf(file.id)}`
        : `data:image/${file.detectedType};base64,${(await addressing.read(file.storageKey)).toString('base64')}`;
    shown.set(file.id, { src, width: file.width, height: file.height });
  }
  return shown;
}

/**
 * Composes a message inside the current transaction, or null when no template of its type
 * exists yet (it waits, and is composed at send time). Throws when the template does not
 * render (a document planted past the checks): the caller decides.
 */
export async function composeMessage(
  tx: Prisma.TransactionClient,
  input: ComposeInput,
  options: ComposeOptions = {},
): Promise<Composed | null> {
  if (!isTemplateType(input.kind)) {
    return null;
  }
  const type = input.kind;
  const language: Language = input.language === 'sr' ? 'sr' : 'en';
  const template = await findTemplate(tx, type, language, input.conferenceId);
  if (template === null) {
    return null;
  }
  const organisation = await tx.organisation.findUniqueOrThrow({
    where: { id: input.organisationId },
    select: { name: true },
  });
  const { values, conditions } = await valuesOf(
    tx,
    input,
    type,
    language,
    organisation.name,
    options,
  );
  const images = await imagesFor(tx, template.body, type, options.images ?? { kind: 'cid' });
  const rendered = renderTemplate(template, catalogueOf(type), {
    values,
    conditions,
    link: LINK_SENTINEL,
    images,
  });
  return {
    ...rendered,
    type,
    language,
    templateServerId: template.mailServerId,
    imageIds: [...images.keys()],
  };
}

/** The stored rendering with its link: a fresh one to send, `[link]` for the log. */
export function withLink(rendered: Rendered, link: string): Rendered {
  return {
    subject: rendered.subject,
    html: rendered.html.split(LINK_SENTINEL).join(link.replace(/&/g, '&amp;')),
    text: rendered.text.split(LINK_SENTINEL).join(link),
  };
}
