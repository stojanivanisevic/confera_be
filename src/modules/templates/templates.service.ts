import { Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { VALIDATION_FAILED } from '../../common/http/validation';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { AuditRecorder } from '../audit/audit-recorder';
import { FileStorage } from '../files/storage';
import { STATUS_TEMPLATE_TYPES } from '../submissions/status-machine';
import {
  checkBody,
  checkSubject,
  type DocNode,
  DocumentError,
  imagesOf,
  type SubjectNode,
} from './document';
import {
  catalogueOf,
  LANGUAGES,
  type Language,
  PLACEHOLDERS,
  TEMPLATE_TYPES,
  type TemplateType,
} from './placeholders';
import { type RenderedImage, RenderError, renderBody, renderSubject } from './render';
import type {
  CreateMailTemplateDto,
  EffectiveTemplateDto,
  MailTemplateDto,
  StatusEmailsDto,
  StatusEmailsUpdateDto,
  TemplatePreviewDto,
  TemplatePreviewRequestDto,
  UpdateMailTemplateDto,
} from './templates.dto';

type TemplateRow = Prisma.MailTemplateGetPayload<object>;

export function toTemplateDto(row: TemplateRow): MailTemplateDto {
  return {
    id: row.id,
    conferenceId: row.conferenceId,
    type: row.type,
    language: row.language,
    subject: row.subject as Record<string, unknown>,
    body: row.body as Record<string, unknown>,
    mailServerId: row.mailServerId,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

/**
 * The sample values of the preview and of the checks on save (FR-MAIL-02): invented, in
 * the template's language, with Serbian letters, and a message of two lines. The secure
 * link of a type that carries one is an address of the admin surface that leads nowhere.
 */
function sampleValues(
  type: TemplateType,
  language: Language,
  names: { organisation: string; conference: string | null; contact?: string | null },
): Record<string, string> {
  const sr = language === 'sr';
  const all: Record<string, string> = {
    recipientName: 'Mila Petrović',
    organisationName: names.organisation,
    inviterName: 'Đorđe Šćepanović',
    expiresIn: sr ? '72 sata' : '72 hours',
    newEmail: 'mila.nova@example.test',
    change: sr ? 'izmenjen je server za poštu' : 'a mail server was changed',
    actorName: 'Đorđe Šćepanović',
    subjectName: 'Mila Petrović',
    serverName: sr ? 'Pošta udruženja' : 'Mail of the association',
    conferenceName:
      names.conference ?? (sr ? 'Probna konferencija 2027' : 'Sample conference 2027'),
    reference: 'IT27-0001',
    title: sr ? 'Učenje na daljinu u malim školama' : 'Distance learning in small schools',
    authorName: 'Živana Đorđević',
    contactEmail: names.contact ?? '',
    message: sr
      ? 'Skratite apstrakt na 300 reči.\nDodajte ključne reči.'
      : 'Please shorten the abstract to 300 words.\nAdd the keywords.',
  };
  return Object.fromEntries(
    PLACEHOLDERS[type].filter((key) => key !== 'link').map((key) => [key, all[key] ?? '']),
  );
}

/** A refusal of the document format as the error format of the API: the path and the code. */
function refusal(part: 'subject' | 'body', error: unknown): never {
  if (error instanceof DocumentError) {
    throw new ProblemException(400, VALIDATION_FAILED, [
      { path: `${part}${error.path.slice(1)}`, code: error.code },
    ]);
  }
  if (error instanceof RenderError) {
    throw new ProblemException(400, VALIDATION_FAILED, [{ path: part, code: error.code }]);
  }
  throw error;
}

/**
 * Template management (M4-BE-03; FR-MAIL-01, FR-MAIL-02 as amended by SA-15; ADR-12):
 * the organisation's templates and the conference overrides, each a version per
 * language; the checks on save (the document format, the catalogue of the type, the
 * images of the organisation, the rendered size); the sample render by the server; the
 * fallback the sender uses, shown per conference; and the status emails switched off per
 * conference (FR-MAIL-07).
 *
 * The defaults are seeded per organisation (M2-ISS-06, decided here): a conference reaches
 * every type in both languages through the fallback, and an override is made when an
 * admin edits a template for one conference.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: AuditRecorder,
    private readonly storage: FileStorage,
  ) {}

  async create(actor: Access, input: CreateMailTemplateDto): Promise<MailTemplateDto> {
    return this.database.transaction(async (tx) => {
      const type = input.type as TemplateType;
      const checked = await this.checked(tx, type, input);
      const conferenceId = input.conferenceId ?? null;
      if (conferenceId !== null) {
        const conference = await tx.conference.findUnique({
          where: { id: conferenceId },
          select: { id: true },
        });
        if (conference === null) {
          throw new ProblemException(404, 'not_found');
        }
      }
      const taken = await tx.mailTemplate.findFirst({
        where: { conferenceId, type: input.type, language: input.language },
        select: { id: true },
      });
      if (taken !== null) {
        throw new ProblemException(409, 'template_exists');
      }
      const row = await tx.mailTemplate.create({
        data: {
          organisationId: actor.organisationId,
          conferenceId,
          type: input.type,
          language: input.language,
          subject: checked.subject as unknown as Prisma.InputJsonValue,
          body: checked.body as unknown as Prisma.InputJsonValue,
          mailServerId: input.mailServerId ?? null,
        },
      });
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'template.created',
        subjectType: 'mail_template',
        subjectId: row.id,
      });
      return toTemplateDto(row);
    });
  }

  async update(actor: Access, id: string, input: UpdateMailTemplateDto): Promise<MailTemplateDto> {
    return this.database.transaction(async (tx) => {
      const before = await tx.mailTemplate.findUnique({ where: { id } });
      if (before === null) {
        throw new ProblemException(404, 'not_found');
      }
      const checked = await this.checked(tx, before.type as TemplateType, input);
      const changed = await tx.mailTemplate.updateMany({
        where: { id, version: input.version },
        data: {
          subject: checked.subject as unknown as Prisma.InputJsonValue,
          body: checked.body as unknown as Prisma.InputJsonValue,
          ...(input.mailServerId === undefined ? {} : { mailServerId: input.mailServerId }),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      const fields = [
        'subject',
        'body',
        ...(input.mailServerId === undefined ? [] : ['mailServerId']),
      ];
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'template.updated',
        subjectType: 'mail_template',
        subjectId: id,
        changes: Object.fromEntries(fields.map((field) => [field, { old: null, new: null }])),
      });
      return toTemplateDto(await tx.mailTemplate.findUniqueOrThrow({ where: { id } }));
    });
  }

  /** Removes a conference override: the conference falls back to the organisation's (ADR-12). */
  async remove(actor: Access, id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const row = await tx.mailTemplate.findUnique({ where: { id } });
      if (row === null) {
        throw new ProblemException(404, 'not_found');
      }
      if (row.conferenceId === null) {
        // The organisation's own are the end of the fallback: edited, never removed.
        throw new ProblemException(409, 'organisation_template');
      }
      await tx.mailTemplate.delete({ where: { id } });
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'template.deleted',
        subjectType: 'mail_template',
        subjectId: id,
      });
    });
  }

  /** The sample render by the server (FR-MAIL-02, ADR-12): the images embedded, nothing saved. */
  async preview(input: TemplatePreviewRequestDto): Promise<TemplatePreviewDto> {
    return this.database.transaction(async (tx) => {
      const type = input.type as TemplateType;
      const checked = await this.checked(tx, type, input);
      const names = await this.namesOf(tx, input.conferenceId ?? null);
      const images = await this.imagesOf(tx, checked.body, true);
      try {
        const values = sampleValues(type, input.language as Language, names);
        // The contact blocks as the organisation would get them now (UX4-06).
        const conditions = new Set(catalogueOf(type).conditions);
        conditions.delete(names.contact === null ? 'hasContact' : 'noContact');
        const rendered = renderBody(checked.body, {
          values,
          conditions,
          link: 'https://admin.confera.example/preview-link',
          images,
        });
        return {
          subject: renderSubject(checked.subject, { values, conditions: new Set() }),
          html: rendered.html,
          text: rendered.text,
          imagesPending: imagesOf(checked.body).filter((id) => !images.has(id)),
        };
      } catch (error) {
        return refusal('body', error);
      }
    });
  }

  /** Which template each type and language of a conference uses, by the fallback of ADR-12. */
  async effective(conferenceId: string | null): Promise<EffectiveTemplateDto[]> {
    const rows = await this.database.db.mailTemplate.findMany({
      where: { OR: [{ conferenceId: null }, ...(conferenceId === null ? [] : [{ conferenceId }])] },
      select: { id: true, conferenceId: true, type: true, language: true },
    });
    const find = (type: string, language: string, conference: string | null) =>
      rows.find(
        (row) => row.type === type && row.language === language && row.conferenceId === conference,
      );
    const result: EffectiveTemplateDto[] = [];
    for (const type of TEMPLATE_TYPES) {
      for (const language of LANGUAGES) {
        const order: [string | null, string, EffectiveTemplateDto['source']][] = [
          ...(conferenceId === null
            ? []
            : ([
                [conferenceId, language, 'conference'],
                [conferenceId, 'en', 'conference_en'],
              ] as [string | null, string, EffectiveTemplateDto['source']][])),
          [null, language, 'organisation'],
          [null, 'en', 'organisation_en'],
        ];
        const hit = order
          .map(([conference, lang, source]) => ({ row: find(type, lang, conference), source }))
          .find((candidate) => candidate.row !== undefined);
        result.push({
          type,
          language,
          source: hit?.source ?? 'none',
          templateId: hit?.row?.id ?? null,
        });
      }
    }
    return result;
  }

  async statusEmails(conferenceId: string): Promise<StatusEmailsDto> {
    const conference = await this.database.db.conference.findUnique({
      where: { id: conferenceId },
      select: { id: true, statusMailOff: true, version: true },
    });
    if (conference === null) {
      throw new ProblemException(404, 'not_found');
    }
    return {
      conferenceId: conference.id,
      types: STATUS_TEMPLATE_TYPES.map((type) => ({
        type,
        enabled: !conference.statusMailOff.includes(type),
      })),
      version: conference.version,
    };
  }

  /** Switches status emails off and on for a conference (FR-MAIL-07). All on by default. */
  async setStatusEmails(
    actor: Access,
    conferenceId: string,
    input: StatusEmailsUpdateDto,
  ): Promise<StatusEmailsDto> {
    await this.database.transaction(async (tx) => {
      const before = await tx.conference.findUnique({
        where: { id: conferenceId },
        select: { statusMailOff: true },
      });
      if (before === null) {
        throw new ProblemException(404, 'not_found');
      }
      const off = STATUS_TEMPLATE_TYPES.filter((type) =>
        input.types.some((entry) => entry.type === type && !entry.enabled),
      ).concat(
        // A type the request does not name keeps its setting.
        STATUS_TEMPLATE_TYPES.filter(
          (type) =>
            before.statusMailOff.includes(type) &&
            !input.types.some((entry) => entry.type === type),
        ),
      );
      const changed = await tx.conference.updateMany({
        where: { id: conferenceId, version: input.version },
        data: {
          statusMailOff: [...new Set(off)].sort(),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'conference.status_emails_changed',
        subjectType: 'conference_status_emails',
        subjectId: conferenceId,
        changes: {
          off: {
            old: [...before.statusMailOff].sort().join(','),
            new: [...new Set(off)].sort().join(','),
          },
        },
      });
    });
    return this.statusEmails(conferenceId);
  }

  /**
   * The checks on save (FR-MAIL-02, ST-58, ST-59, ST-60): the format and the catalogue of
   * the type; every image an email image of this organisation (row-level security leaves
   * another's out); the server of the template one of the organisation's; and the body as
   * rendered with the sample values under its limit.
   */
  private async checked(
    tx: Prisma.TransactionClient,
    type: TemplateType,
    input: { subject: unknown; body: unknown; mailServerId?: string | null; language?: string },
  ): Promise<{ subject: SubjectNode; body: DocNode }> {
    const catalogue = catalogueOf(type);
    let subject: SubjectNode;
    let body: DocNode;
    try {
      subject = checkSubject(input.subject, catalogue);
    } catch (error) {
      return refusal('subject', error);
    }
    try {
      body = checkBody(input.body, catalogue);
    } catch (error) {
      return refusal('body', error);
    }
    const wanted = imagesOf(body);
    if (wanted.length > 0) {
      const found = await tx.storedFile.findMany({
        where: { id: { in: wanted }, kind: 'email_image' },
        select: { id: true },
      });
      const unknown = wanted.filter((id) => !found.some((file) => file.id === id));
      if (unknown.length > 0) {
        throw new ProblemException(400, VALIDATION_FAILED, [
          { path: 'body', code: 'image_unknown' },
        ]);
      }
    }
    if (input.mailServerId !== undefined && input.mailServerId !== null) {
      const server = await tx.mailServer.findUnique({
        where: { id: input.mailServerId },
        select: { id: true },
      });
      if (server === null) {
        throw new ProblemException(400, VALIDATION_FAILED, [
          { path: 'mailServerId', code: 'mail_server_unknown' },
        ]);
      }
    }
    // A body above the limit once rendered is refused now, not when it would be sent (ST-59).
    const images = await this.imagesOf(tx, body, false);
    try {
      renderBody(body, {
        values: sampleValues(type, (input.language ?? 'en') as Language, {
          organisation: 'x'.repeat(100),
          conference: 'x'.repeat(200),
          contact: `${'x'.repeat(240)}@example.test`,
        }),
        conditions: new Set(catalogue.conditions),
        link: 'https://admin.confera.example/a-link-of-the-length-of-a-real-one-0123456789',
        images,
      });
    } catch (error) {
      return refusal('body', error);
    }
    return { subject, body };
  }

  private async namesOf(
    tx: Prisma.TransactionClient,
    conferenceId: string | null,
  ): Promise<{ organisation: string; conference: string | null; contact: string | null }> {
    const organisation = await tx.organisation.findFirstOrThrow({
      select: { name: true, contactEmail: true },
    });
    const conference =
      conferenceId === null
        ? null
        : await tx.conference.findUnique({ where: { id: conferenceId }, select: { name: true } });
    return {
      organisation: organisation.name,
      conference: conference?.name ?? null,
      contact: organisation.contactEmail,
    };
  }

  /** The images of a body that may be shown: clean email images, as data for the preview. */
  private async imagesOf(
    tx: Prisma.TransactionClient,
    body: DocNode,
    asData: boolean,
  ): Promise<Map<string, RenderedImage>> {
    const shown = new Map<string, RenderedImage>();
    const ids = imagesOf(body);
    if (ids.length === 0) {
      return shown;
    }
    const files = await tx.storedFile.findMany({
      where: { id: { in: ids }, kind: 'email_image', scanState: 'clean' },
      select: { id: true, storageKey: true, detectedType: true, width: true, height: true },
    });
    for (const file of files) {
      if (file.width === null || file.height === null) {
        continue;
      }
      let src = `cid:${file.id}@confera`;
      if (asData) {
        const chunks: Buffer[] = [];
        for await (const chunk of this.storage.read(file.storageKey)) {
          chunks.push(chunk as Buffer);
        }
        src = `data:image/${file.detectedType};base64,${Buffer.concat(chunks).toString('base64')}`;
      }
      shown.set(file.id, { src, width: file.width, height: file.height });
    }
    return shown;
  }
}
