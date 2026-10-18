import { Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { downloadBlocked, mayServe } from '../files/serving';
import { heldNumbersOf } from '../held-mail/send-breaker';
import { searchTerms } from './search';
import { actionsFrom, type SubmissionStatus } from './status-machine';
import {
  MAX_PAGE_SIZE,
  SCAN_FLAGS,
  type SubmissionDetailDto,
  type SubmissionPageDto,
  type SubmissionQueryDto,
  type SubmissionSort,
  type SubmissionSummaryDto,
} from './submissions.dto';

const DEFAULT_PAGE_SIZE = 25;

type SummaryRow = Prisma.SubmissionGetPayload<{
  include: { conference: { select: { id: true; code: true; name: true; editionYear: true } } };
}> & { readonly files: readonly { scanState: string; scanFlag: string | null }[] };

function scanFlagOf(flag: string | null): (typeof SCAN_FLAGS)[number] | null {
  return SCAN_FLAGS.find((known) => known === flag) ?? null;
}

/** The fields of a row of the table, as a plain object (a detail spreads it). */
type Summary = { [Field in keyof SubmissionSummaryDto]: SubmissionSummaryDto[Field] };

function summary(row: SummaryRow): Summary {
  return {
    id: row.id,
    reference: row.reference,
    conference: row.conference,
    title: row.title,
    firstAuthor: row.firstAuthorName,
    institution: row.firstAuthorInstitution,
    participationType: row.participationType,
    status: row.status as SubmissionStatus,
    memberMatch: null,
    billingStatus: null,
    language: row.language,
    authorCount: row.authorCount,
    receivedAt: row.receivedAt.toISOString(),
    fileSigns: {
      flags: SCAN_FLAGS.filter((flag) => row.files.some((file) => file.scanFlag === flag)),
      scanPending: row.files.some((file) => file.scanState === 'pending'),
    },
    version: row.version,
  };
}

/**
 * The fixed map of the orders (M4-BE-04): a name of the query to columns, never a column
 * named by the client. The id breaks every tie, so that a page boundary never moves.
 */
function orderOf(
  sort: SubmissionSort,
  order: 'asc' | 'desc',
): Prisma.SubmissionOrderByWithRelationInput[] {
  const by: Record<SubmissionSort, Prisma.SubmissionOrderByWithRelationInput[]> = {
    receivedAt: [{ receivedAt: order }],
    reference: [{ reference: order }],
    title: [{ title: { sort: order, nulls: 'last' } }],
    firstAuthor: [{ firstAuthorName: order }],
    institution: [{ firstAuthorInstitution: { sort: order, nulls: 'last' } }],
    participationType: [{ participationType: { sort: order, nulls: 'last' } }],
    status: [{ status: order }],
    conference: [{ conference: { code: order } }, { conference: { editionYear: order } }],
  };
  return [
    ...by[sort],
    ...(sort === 'receivedAt' ? [] : [{ receivedAt: 'desc' as const }]),
    { id: order },
  ];
}

/** The filters and the search of the table as a condition (FR-SUB-03). */
export function whereOf(query: SubmissionQueryDto): Prisma.SubmissionWhereInput {
  const and: Prisma.SubmissionWhereInput[] = [];
  if (query.conferenceId !== undefined) {
    and.push({ conferenceId: query.conferenceId });
  }
  // A withdrawn submission leaves the default view and is found with the filter (FR-SUB-08).
  and.push(
    query.status === undefined || query.status.length === 0
      ? { status: { not: 'withdrawn' } }
      : { status: { in: query.status } },
  );
  if (query.participationType !== undefined && query.participationType.length > 0) {
    and.push({ participationType: { in: query.participationType } });
  }
  for (const term of searchTerms(query.q ?? '')) {
    and.push({ searchText: { contains: term } });
  }
  return { AND: and };
}

/**
 * The submissions of the organisation, read only (FR-SUB-02 to 04): the paged table with
 * its search, filters and order, and one submission with everything about it. Reading
 * changes nothing (ST-43): the move from New to Open is a POST of its own.
 */
@Injectable()
export class SubmissionsService {
  constructor(private readonly database: TenantDatabase) {}

  async list(query: SubmissionQueryDto): Promise<SubmissionPageDto> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const sort = query.sort ?? 'receivedAt';
    const order = query.order ?? (sort === 'receivedAt' ? 'desc' : 'asc');
    const where = whereOf(query);
    const [total, rows] = await this.database.transaction((tx) =>
      Promise.all([
        tx.submission.count({ where }),
        tx.submission.findMany({
          where,
          include: {
            conference: { select: { id: true, code: true, name: true, editionYear: true } },
            files: { select: { scanState: true, scanFlag: true } },
          },
          orderBy: orderOf(sort, order),
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]),
    );
    return { items: rows.map(summary), total, page, pageSize };
  }

  async detail(id: string): Promise<SubmissionDetailDto> {
    return this.database.transaction(async (tx) => {
      const row = await tx.submission.findUnique({
        where: { id },
        include: {
          conference: { select: { id: true, code: true, name: true, editionYear: true } },
          form: { select: { id: true, publicKey: true } },
          formVersion: { select: { number: true } },
          authors: { orderBy: { position: 'asc' } },
          files: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          statuses: { orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] },
          messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          notes: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            include: { author: { select: { id: true, displayName: true } } },
          },
          revisions: {
            orderBy: { number: 'asc' },
            include: { changer: { select: { id: true, displayName: true } } },
          },
        },
      });
      if (row === null) {
        throw new ProblemException(404, 'not_found');
      }
      const actors = await tx.user.findMany({
        where: {
          id: {
            in: row.statuses
              .map((status) => status.actorUserId)
              .filter((value): value is string => value !== null),
          },
        },
        select: { id: true, displayName: true },
      });
      const links = row.consentLinks as Record<string, string | null>;
      return {
        ...summary(row),
        form: { id: row.form.id, slug: row.form.publicKey, versionNumber: row.formVersion.number },
        answers: row.answers as Record<string, unknown>,
        authors: row.authors.map((author) => ({
          position: author.position,
          firstName: author.firstName,
          lastName: author.lastName,
          institution: author.institution,
          institutionAddress: author.institutionAddress,
          orcid: author.orcid,
          email: author.email,
          phone: author.phone,
          isCorresponding: author.isCorresponding,
        })),
        files: row.files.map((file) => ({
          id: file.id,
          field: file.fieldKey,
          name: file.originalName,
          type: file.detectedType,
          sizeBytes: file.sizeBytes,
          scanState: file.scanState as 'pending' | 'clean' | 'infected' | 'not_clean',
          scanFlag: scanFlagOf(file.scanFlag),
          scannedAt: file.scannedAt?.toISOString() ?? null,
          pendingSince:
            file.scanState === 'pending' ? (file.attachedAt ?? file.createdAt).toISOString() : null,
          nextScanAt: file.scanState === 'pending' ? file.nextScanAt.toISOString() : null,
          downloadBlocked: downloadBlocked(file),
          sha256: file.sha256,
        })),
        consent: {
          text: row.consentText,
          links,
          version: row.consentVersion,
          consentedAt: row.consentedAt.toISOString(),
        },
        statusHistory: row.statuses.map((status) => ({
          status: status.status as SubmissionStatus,
          fromStatus: status.fromStatus as SubmissionStatus | null,
          transition: status.transition,
          changedAt: status.changedAt.toISOString(),
          actor: actors.find((actor) => actor.id === status.actorUserId) ?? null,
          reason: status.reason,
          message: status.message,
          email: status.mailState as 'queued' | 'template_off' | 'none',
          emailId: status.messageId,
        })),
        actions: actionsFrom(row.status),
        emails: row.messages.map((message) => ({
          id: message.id,
          kind: message.kind,
          recipient: message.recipientAddress,
          status: message.status,
          heldReason: message.heldReason,
          heldBy: heldNumbersOf(message),
          lastErrorCode: message.lastErrorCode,
          createdAt: message.createdAt.toISOString(),
          sentAt: message.sentAt?.toISOString() ?? null,
        })),
        notes: row.notes.map((note) => ({
          id: note.id,
          body: note.body,
          author: note.author,
          createdAt: note.createdAt.toISOString(),
        })),
        revisions: row.revisions.map((revision) => ({
          number: revision.number,
          changedAt: revision.changedAt.toISOString(),
          changedBy: revision.changer,
          fields: revision.fields,
          before: revision.before as Record<string, unknown>,
          after: revision.after as Record<string, unknown>,
        })),
      };
    });
  }

  /** The file of a submission, if its owner and its scan allow it (FR-FILE-02, ST-38). */
  async file(submissionId: string, fileId: string) {
    const file = await this.database.db.storedFile.findFirst({
      where: { id: fileId, submissionId },
    });
    if (file === null) {
      throw new ProblemException(404, 'not_found');
    }
    const decision = mayServe(file);
    if (decision !== 'serve') {
      throw new ProblemException(409, decision);
    }
    return file;
  }
}
