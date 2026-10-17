import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { VALIDATION_FAILED } from '../../common/http/validation';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { AuditRecorder } from '../audit/audit-recorder';
import { type FormType, isFormType } from './catalogue';
import { checkConfiguration, type FormConfiguration } from './configuration';
import { buildDefinition } from './definition';
import { DEADLINE_OF_FORM, formState } from './form-state';
import type { FormDto, FormSummaryDto, FormVersionDto, FormVersionSummaryDto } from './forms.dto';

type FormRow = Prisma.FormGetPayload<object>;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A public key: 16 random letters and digits (about 82 bits), the address of a form. */
export function newPublicKey(): string {
  let key = '';
  while (key.length < 16) {
    for (const byte of randomBytes(24)) {
      // 252 = 7 * 36: no letter is likelier than another.
      if (byte < 252 && key.length < 16) {
        key += ALPHABET[byte % 36] ?? '';
      }
    }
  }
  return key;
}

/** The stored configuration of a form, checked again when it is read. */
function storedConfiguration(type: FormType, value: unknown): FormConfiguration {
  const checked = checkConfiguration(type, value);
  if (!checked.ok) {
    throw new ProblemException(409, 'form_configuration_invalid');
  }
  return checked.configuration;
}

function typeOf(row: FormRow): FormType {
  if (!isFormType(row.type)) {
    throw new ProblemException(409, 'form_type_unknown');
  }
  return row.type;
}

/**
 * Forms of the conferences (M3-BE-01; FR-FORM-01, FR-FORM-02): one per type and conference,
 * configured within the catalogue, published as immutable versions. Inside the organisation
 * of the signed-in admin, under row-level security.
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: AuditRecorder,
  ) {}

  async list(conferenceId?: string): Promise<FormSummaryDto[]> {
    return this.database.transaction(async (tx) => {
      const rows = await tx.form.findMany({
        where: conferenceId === undefined ? {} : { conferenceId },
        include: { currentVersion: { select: { number: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const now = new Date();
      const summaries: FormSummaryDto[] = [];
      for (const row of rows) {
        const state = formState(await this.situation(tx, row), now);
        summaries.push({
          id: row.id,
          conferenceId: row.conferenceId,
          type: typeOf(row),
          slug: row.publicKey,
          currentVersionNumber: row.currentVersion?.number ?? null,
          state: state.state,
          closedReason: state.closedReason,
          version: row.version,
        });
      }
      return summaries;
    });
  }

  async get(id: string): Promise<FormDto> {
    return this.database.transaction((tx) => this.dto(tx, id));
  }

  async create(actor: Access, conferenceId: string, type: string): Promise<FormDto> {
    if (!isFormType(type)) {
      throw new ProblemException(400, VALIDATION_FAILED, [{ path: 'type', code: 'isIn' }]);
    }
    return this.database.transaction(async (tx) => {
      const conference = await tx.conference.findUnique({ where: { id: conferenceId } });
      if (conference === null) {
        throw new ProblemException(404, 'not_found');
      }
      if (conference.state === 'archived') {
        throw new ProblemException(409, 'conference_archived');
      }
      const existing = await tx.form.findFirst({ where: { conferenceId, type } });
      if (existing !== null) {
        throw new ProblemException(409, 'form_exists');
      }
      const row = await tx.form.create({
        data: {
          organisationId: actor.organisationId,
          conferenceId,
          type,
          publicKey: newPublicKey(),
          configuration: {},
        },
      });
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'form.created',
        subjectType: 'form',
        subjectId: row.id,
      });
      return this.dto(tx, row.id);
    });
  }

  async saveDraft(
    actor: Access,
    id: string,
    configuration: unknown,
    version: number,
  ): Promise<FormDto> {
    return this.database.transaction(async (tx) => {
      const row = await this.load(tx, id);
      const checked = checkConfiguration(typeOf(row), configuration);
      if (!checked.ok) {
        throw new ProblemException(
          400,
          VALIDATION_FAILED,
          checked.problems.map(({ path, code }) => ({
            path: path === '' ? 'configuration' : `configuration.${path}`,
            code,
          })),
        );
      }
      const changed = await tx.form.updateMany({
        where: { id, version },
        data: {
          configuration: checked.configuration as Prisma.InputJsonValue,
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
        action: 'form.draft_changed',
        subjectType: 'form',
        subjectId: id,
        changes: { configuration: { old: null, new: null } },
      });
      return this.dto(tx, id);
    });
  }

  /** Publishes the draft as a new, immutable version (ADR-06); the public form shows it at once. */
  async publish(actor: Access, id: string, version: number): Promise<FormDto> {
    return this.database.transaction(async (tx) => {
      const row = await this.load(tx, id);
      if (row.version !== version) {
        throw new ProblemException(409, 'version_conflict');
      }
      const type = typeOf(row);
      const definition = buildDefinition(type, storedConfiguration(type, row.configuration));
      const last = await tx.formVersion.findFirst({
        where: { formId: id },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const published = await tx.formVersion.create({
        data: {
          organisationId: actor.organisationId,
          formId: id,
          number: (last?.number ?? 0) + 1,
          definition: definition as unknown as Prisma.InputJsonValue,
          publishedBy: actor.userId,
        },
      });
      const changed = await tx.form.updateMany({
        where: { id, version },
        data: { currentVersionId: published.id, version: { increment: 1 }, updatedAt: new Date() },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'form.published',
        subjectType: 'form',
        subjectId: id,
        changes: {
          versionNumber: {
            old: last === null ? null : String(last.number),
            new: String(published.number),
          },
        },
      });
      return this.dto(tx, id);
    });
  }

  async setBreaker(
    actor: Access,
    id: string,
    input: { breakerPerHour: number; breakerPerDay: number; version: number },
  ): Promise<FormDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.load(tx, id);
      const changed = await tx.form.updateMany({
        where: { id, version: input.version },
        data: {
          breakerPerHour: input.breakerPerHour,
          breakerPerDay: input.breakerPerDay,
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
        action: 'form.breaker_changed',
        subjectType: 'form',
        subjectId: id,
        changes: {
          breakerPerHour: {
            old: String(before.breakerPerHour),
            new: String(input.breakerPerHour),
          },
          breakerPerDay: { old: String(before.breakerPerDay), new: String(input.breakerPerDay) },
        },
      });
      return this.dto(tx, id);
    });
  }

  async version(id: string, number: number): Promise<FormVersionDto> {
    return this.database.transaction(async (tx) => {
      await this.load(tx, id);
      const row = await tx.formVersion.findFirst({
        where: { formId: id, number },
        include: { publisher: { select: { id: true, displayName: true } } },
      });
      if (row === null) {
        throw new ProblemException(404, 'not_found');
      }
      return {
        number: row.number,
        publishedAt: row.publishedAt.toISOString(),
        publishedBy: row.publisher,
        definition: row.definition as Record<string, unknown>,
      };
    });
  }

  private async load(tx: Prisma.TransactionClient, id: string): Promise<FormRow> {
    const row = await tx.form.findUnique({ where: { id } });
    if (row === null) {
      throw new ProblemException(404, 'not_found');
    }
    return row;
  }

  private async situation(tx: Prisma.TransactionClient, row: FormRow) {
    const conference = await tx.conference.findUniqueOrThrow({
      where: { id: row.conferenceId },
      select: { state: true, timeZone: true },
    });
    const deadline = await tx.conferenceDeadline.findFirst({
      where: { conferenceId: row.conferenceId, kind: DEADLINE_OF_FORM[typeOf(row)] },
      select: { endsOn: true },
    });
    return {
      conferenceState: conference.state,
      timeZone: conference.timeZone,
      published: row.currentVersionId !== null,
      deadline: deadline?.endsOn ?? null,
    };
  }

  private async dto(tx: Prisma.TransactionClient, id: string): Promise<FormDto> {
    const row = await this.load(tx, id);
    const type = typeOf(row);
    const versions = await tx.formVersion.findMany({
      where: { formId: id },
      include: { publisher: { select: { id: true, displayName: true } } },
      orderBy: { number: 'asc' },
    });
    const summary = (version: (typeof versions)[number]): FormVersionSummaryDto => ({
      number: version.number,
      publishedAt: version.publishedAt.toISOString(),
      publishedBy: version.publisher,
    });
    const current = versions.find((version) => version.id === row.currentVersionId);
    const state = formState(await this.situation(tx, row), new Date());
    const configuration = storedConfiguration(type, row.configuration);
    return {
      id: row.id,
      conferenceId: row.conferenceId,
      type,
      slug: row.publicKey,
      configuration: configuration as Record<string, unknown>,
      draftDefinition: buildDefinition(type, configuration) as unknown as Record<string, unknown>,
      currentVersion: current === undefined ? null : summary(current),
      versions: versions.map(summary),
      state: state.state,
      closedReason: state.closedReason,
      breakerPerHour: row.breakerPerHour,
      breakerPerDay: row.breakerPerDay,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }
}
