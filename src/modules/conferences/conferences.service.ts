import { Inject, Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { VALIDATION_FAILED } from '../../common/http/validation';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { AuditRecorder, type FieldChange } from '../audit/audit-recorder';
import type {
  ConferenceDto,
  ConferenceState,
  CopyConferenceDto,
  CreateConferenceDto,
  UpdateConferenceDto,
} from './conferences.dto';
import { newPublicKey } from '../forms/forms.service';
import { normaliseSites } from './listed-sites';

type ConferenceRow = Prisma.ConferenceGetPayload<object>;

/** The fields a create or change may set besides name and code. */
interface ConferenceFields {
  listedSites?: string[];
  editionYear?: number | null;
  startsOn?: Date | null;
  endsOn?: Date | null;
  venue?: string | null;
  languages?: string[];
  timeZone?: string;
  mailServerId?: string | null;
  publicationTermsUrl?: string | null;
  privacyNoticeUrl?: string | null;
}

const AUDITED = [
  'name',
  'code',
  'editionYear',
  'startsOn',
  'endsOn',
  'venue',
  'listedSites',
  'languages',
  'timeZone',
  'state',
  'mailServerId',
  'publicationTermsUrl',
  'privacyNoticeUrl',
] as const;

/** The changes of state FR-CONF-04 allows. Archived is final and read-only. */
const NEXT_STATES: Readonly<Record<ConferenceState, readonly ConferenceState[]>> = {
  draft: ['open', 'archived'],
  open: ['closed'],
  closed: ['open', 'archived'],
  archived: [],
};

function dateOf(value: string | null | undefined): Date | null | undefined {
  return value === undefined ? undefined : value === null ? null : new Date(`${value}T00:00:00Z`);
}

function dayOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export function toConferenceDto(row: ConferenceRow): ConferenceDto {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    editionYear: row.editionYear,
    startsOn: dayOf(row.startsOn),
    endsOn: dayOf(row.endsOn),
    venue: row.venue,
    listedSites: row.listedSites,
    languages: row.languages,
    timeZone: row.timeZone,
    state: row.state as ConferenceState,
    mailServerId: row.mailServerId,
    publicationTermsUrl: row.publicationTermsUrl,
    privacyNoticeUrl: row.privacyNoticeUrl,
    version: row.version,
  };
}

/**
 * Conferences (FR-CONF-01 to 04; ST-30). Inside the organisation of the signed-in admin,
 * under row-level security. Two conferences share nothing: a copy is a new row with copies
 * of the templates, and changing one never changes the other.
 */
@Injectable()
export class ConferencesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: TenantDatabase,
    private readonly audit: AuditRecorder,
  ) {}

  async list(state?: ConferenceState): Promise<ConferenceDto[]> {
    const rows = await this.database.db.conference.findMany({
      where: state === undefined ? {} : { state },
      orderBy: [{ code: 'asc' }, { editionYear: { sort: 'desc', nulls: 'first' } }, { id: 'asc' }],
    });
    return rows.map(toConferenceDto);
  }

  async get(id: string): Promise<ConferenceDto> {
    return toConferenceDto(await this.database.transaction((tx) => this.load(tx, id)));
  }

  async create(actor: Access, input: CreateConferenceDto): Promise<ConferenceDto> {
    const fields = this.fields(input, null);
    return this.write(async (tx) => {
      const row = await tx.conference.create({
        data: {
          organisationId: actor.organisationId,
          name: input.name,
          code: input.code,
          ...fields,
        },
      });
      await this.record(tx, actor, 'conference.created', null, row);
      return row;
    });
  }

  async update(actor: Access, id: string, input: UpdateConferenceDto): Promise<ConferenceDto> {
    return this.write(async (tx) => {
      const before = await this.load(tx, id);
      if (before.state === 'archived') {
        throw new ProblemException(409, 'conference_archived');
      }
      const fields = this.fields(input, before);
      const changed = await tx.conference.updateMany({
        where: { id, version: input.version },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.code === undefined ? {} : { code: input.code }),
          ...fields,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      const after = await this.load(tx, id);
      await this.record(tx, actor, 'conference.updated', before, after);
      return after;
    });
  }

  async changeState(
    actor: Access,
    id: string,
    state: ConferenceState,
    version: number,
  ): Promise<ConferenceDto> {
    return this.write(async (tx) => {
      const before = await this.load(tx, id);
      if (before.state !== state) {
        if (!NEXT_STATES[before.state as ConferenceState].includes(state)) {
          throw new ProblemException(409, 'state_change_not_allowed');
        }
      }
      const changed = await tx.conference.updateMany({
        where: { id, version },
        data: { state, version: { increment: 1 }, updatedAt: new Date() },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      const after = await this.load(tx, id);
      await this.record(tx, actor, 'conference.state_changed', before, after);
      return after;
    });
  }

  /** A copy (FR-CONF-03): settings, listed sites, mail server, templates and forms (as drafts); no dates. A draft. */
  async copy(actor: Access, id: string, input: CopyConferenceDto): Promise<ConferenceDto> {
    return this.write(async (tx) => {
      const source = await this.load(tx, id);
      const row = await tx.conference.create({
        data: {
          organisationId: actor.organisationId,
          name: input.name,
          code: input.code ?? source.code,
          editionYear: input.editionYear ?? null,
          venue: source.venue,
          listedSites: source.listedSites,
          languages: source.languages,
          timeZone: source.timeZone,
          mailServerId: source.mailServerId,
          publicationTermsUrl: source.publicationTermsUrl,
          privacyNoticeUrl: source.privacyNoticeUrl,
        },
      });
      // Its forms come along as drafts with the same configuration, unpublished, each with
      // an address of its own (FR-CONF-03, M3-BE-01).
      const forms = await tx.form.findMany({ where: { conferenceId: source.id } });
      for (const form of forms) {
        await tx.form.create({
          data: {
            organisationId: actor.organisationId,
            conferenceId: row.id,
            type: form.type,
            publicKey: newPublicKey(),
            configuration: form.configuration as Prisma.InputJsonValue,
            breakerPerHour: form.breakerPerHour,
            breakerPerDay: form.breakerPerDay,
          },
        });
      }
      const templates = await tx.mailTemplate.findMany({ where: { conferenceId: source.id } });
      for (const template of templates) {
        await tx.mailTemplate.create({
          data: {
            organisationId: actor.organisationId,
            conferenceId: row.id,
            type: template.type,
            language: template.language,
            subject: template.subject as Prisma.InputJsonValue,
            body: template.body as Prisma.InputJsonValue,
            mailServerId: template.mailServerId,
          },
        });
      }
      await this.record(tx, actor, 'conference.copied', null, row, source.id);
      return row;
    });
  }

  /** The checked fields of a create or change; the listed sites as origins (ST-30). */
  private fields(
    input: CreateConferenceDto | UpdateConferenceDto,
    before: ConferenceRow | null,
  ): ConferenceFields {
    const data: ConferenceFields = {};
    if (input.listedSites !== undefined) {
      const result = normaliseSites(input.listedSites, this.config.stage);
      if (!result.ok) {
        throw new ProblemException(400, VALIDATION_FAILED, [
          { path: `listedSites[${String(result.index)}]`, code: `site_${result.problem}` },
        ]);
      }
      data.listedSites = result.sites;
    }
    const startsOn = dateOf(input.startsOn);
    const endsOn = dateOf(input.endsOn);
    const start = startsOn === undefined ? (before?.startsOn ?? null) : startsOn;
    const end = endsOn === undefined ? (before?.endsOn ?? null) : endsOn;
    if (start !== null && end !== null && end.getTime() < start.getTime()) {
      throw new ProblemException(400, VALIDATION_FAILED, [
        { path: 'endsOn', code: 'endsBeforeStart' },
      ]);
    }
    const given: ConferenceFields = {
      editionYear: input.editionYear,
      startsOn,
      endsOn,
      venue: input.venue,
      languages: input.languages,
      timeZone: input.timeZone,
      mailServerId: input.mailServerId,
      publicationTermsUrl: input.publicationTermsUrl,
      privacyNoticeUrl: input.privacyNoticeUrl,
    };
    for (const [key, value] of Object.entries(given) as [keyof ConferenceFields, unknown][]) {
      if (value !== undefined) {
        (data as Record<string, unknown>)[key] = value;
      }
    }
    return data;
  }

  /** Runs a change; a taken code and edition, or an unknown mail server, are answered by name. */
  private async write(
    work: (tx: Prisma.TransactionClient) => Promise<ConferenceRow>,
  ): Promise<ConferenceDto> {
    try {
      return toConferenceDto(await this.database.transaction(work));
    } catch (error) {
      // The known request errors of Prisma, by their code (P2002 unique, P2003 foreign key).
      const code = (error as { code?: unknown }).code;
      {
        if (code === 'P2002') {
          throw new ProblemException(409, 'conference_code_taken');
        }
        if (code === 'P2003') {
          throw new ProblemException(400, VALIDATION_FAILED, [
            { path: 'mailServerId', code: 'unknownMailServer' },
          ]);
        }
      }
      throw error;
    }
  }

  private async load(tx: Prisma.TransactionClient, id: string): Promise<ConferenceRow> {
    const row = await tx.conference.findUnique({ where: { id } });
    if (row === null) {
      throw new ProblemException(404, 'not_found');
    }
    return row;
  }

  private async record(
    tx: Prisma.TransactionClient,
    actor: Access,
    action:
      | 'conference.created'
      | 'conference.updated'
      | 'conference.state_changed'
      | 'conference.copied',
    before: ConferenceRow | null,
    after: ConferenceRow,
    copiedFrom?: string,
  ): Promise<void> {
    const show = (row: ConferenceRow | null, field: (typeof AUDITED)[number]): string | null => {
      if (row === null) {
        return null;
      }
      const value = row[field];
      if (value === null) {
        return null;
      }
      if (value instanceof Date) {
        return dayOf(value);
      }
      return Array.isArray(value) ? value.join(' ') || null : String(value);
    };
    const changes: Record<string, FieldChange> = {};
    for (const field of AUDITED) {
      const old = show(before, field);
      const next = show(after, field);
      if (old !== next) {
        changes[field] = { old, new: next };
      }
    }
    if (copiedFrom !== undefined) {
      changes.copiedFrom = { old: null, new: null };
    }
    await this.audit.record(tx, {
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      action,
      subjectType: 'conference',
      subjectId: after.id,
      changes,
    });
  }
}
