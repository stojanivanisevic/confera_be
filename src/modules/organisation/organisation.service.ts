import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { ProblemException } from '../../common/http/problem';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { AuditRecorder, type FieldChange } from '../audit/audit-recorder';
import { MailQueue } from '../mail/mail-queue';
import type { OrganisationDto, PaymentDetailsDto, UpdateOrganisationDto } from './organisation.dto';

const PROFILE_FIELDS = [
  'name',
  'legalName',
  'address',
  'registrationNumber',
  'taxNumber',
  'contactEmail',
  'vatNoteSr',
  'vatNoteEn',
] as const;

const PAYMENT_FIELDS = ['rsdAccount', 'eurIban', 'eurSwift', 'eurBankName', 'paypalPayee'] as const;

type OrganisationRow = Prisma.OrganisationGetPayload<object>;

/**
 * The organisation profile (FR-ORG-01 to 03; ST-19). Read and changed inside the
 * organisation of the signed-in admin, under row-level security: an admin reads and
 * changes the own organisation and no other. The profile and the payment details are two
 * changes: the payment details need the password asked again, tell every active admin,
 * and record who changed them and when (for the banner of the issue screen, FR-ORG-03).
 */
@Injectable()
export class OrganisationService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: AuditRecorder,
    private readonly mail: MailQueue,
  ) {}

  async get(organisationId: string): Promise<OrganisationDto> {
    return this.database.transaction(async (tx) =>
      this.describe(tx, await this.load(tx, organisationId)),
    );
  }

  async update(actor: Access, input: UpdateOrganisationDto): Promise<OrganisationDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.load(tx, actor.organisationId);
      const data: Prisma.OrganisationUpdateManyMutationInput = {};
      if (input.name !== undefined) {
        data.name = input.name;
      }
      for (const field of PROFILE_FIELDS) {
        if (field !== 'name' && input[field] !== undefined) {
          data[field] = input[field];
        }
      }
      const after = await this.write(tx, before, input.version, data);
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'organisation.updated',
        subjectType: 'organisation',
        subjectId: actor.organisationId,
        changes: this.changes(before, after, PROFILE_FIELDS),
      });
      return this.describe(tx, after);
    });
  }

  async changePaymentDetails(actor: Access, input: PaymentDetailsDto): Promise<OrganisationDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.load(tx, actor.organisationId);
      const now = new Date();
      const after = await this.write(tx, before, input.version, {
        rsdAccount: input.rsdAccount ?? null,
        eurIban: input.eurIban === null ? null : input.eurIban.replace(/ /g, '').toUpperCase(),
        eurSwift: input.eurSwift ?? null,
        eurBankName: input.eurBankName ?? null,
        paypalPayee: input.paypalPayee ?? null,
        paymentDetailsChangedAt: now,
        paymentDetailsChangedBy: actor.userId,
      });
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'organisation.payment_details_changed',
        subjectType: 'organisation',
        subjectId: actor.organisationId,
        changes: this.changes(before, after, PAYMENT_FIELDS),
      });
      await this.mail.noticeToAdmins(
        tx,
        actor.organisationId,
        'organisation_payment_details_changed',
        {
          actorUserId: actor.userId,
        },
      );
      return this.describe(tx, after);
    });
  }

  private async load(tx: Prisma.TransactionClient, id: string): Promise<OrganisationRow> {
    const organisation = await tx.organisation.findUnique({ where: { id } });
    if (organisation === null) {
      throw new ProblemException(404, 'not_found');
    }
    return organisation;
  }

  /** Writes a change made on `version`; refuses it when the profile has changed since (409). */
  private async write(
    tx: Prisma.TransactionClient,
    before: OrganisationRow,
    version: number,
    data: Prisma.OrganisationUpdateManyMutationInput,
  ): Promise<OrganisationRow> {
    const changed = await tx.organisation.updateMany({
      where: { id: before.id, version },
      data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (changed.count !== 1) {
      throw new ProblemException(409, 'version_conflict');
    }
    return tx.organisation.findUniqueOrThrow({ where: { id: before.id } });
  }

  private changes(
    before: OrganisationRow,
    after: OrganisationRow,
    fields: readonly (keyof OrganisationRow)[],
  ): Record<string, FieldChange> {
    const changes: Record<string, FieldChange> = {};
    for (const field of fields) {
      const old = String(before[field] ?? '') || null;
      const next = String(after[field] ?? '') || null;
      if (old !== next) {
        changes[field] = { old, new: next };
      }
    }
    return changes;
  }

  private async describe(
    tx: Prisma.TransactionClient,
    organisation: OrganisationRow,
  ): Promise<OrganisationDto> {
    const changer =
      organisation.paymentDetailsChangedBy === null
        ? null
        : await tx.user.findUnique({
            where: { id: organisation.paymentDetailsChangedBy },
            select: { id: true, displayName: true },
          });
    return {
      id: organisation.id,
      name: organisation.name,
      legalName: organisation.legalName,
      address: organisation.address,
      registrationNumber: organisation.registrationNumber,
      taxNumber: organisation.taxNumber,
      contactEmail: organisation.contactEmail,
      vatNoteSr: organisation.vatNoteSr,
      vatNoteEn: organisation.vatNoteEn,
      rsdAccount: organisation.rsdAccount,
      eurIban: organisation.eurIban,
      eurSwift: organisation.eurSwift,
      eurBankName: organisation.eurBankName,
      paypalPayee: organisation.paypalPayee,
      paymentDetailsChangedAt: organisation.paymentDetailsChangedAt?.toISOString() ?? null,
      paymentDetailsChangedBy: changer,
      version: organisation.version,
    };
  }
}
