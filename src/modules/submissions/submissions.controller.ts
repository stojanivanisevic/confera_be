import {
  Get,
  HttpStatus,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProblemException } from '../../common/http/problem';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { Permission } from '../access/access.decorators';
import { FilesModule } from '../files/files.module';
import { FileStorage } from '../files/storage';
import { attachmentHeader } from '../files/file-names';
import { MEDIA_TYPES } from '../files/file-type';
import { mayServe } from '../files/serving';
import type { FileType } from '../forms/catalogue';
import {
  MAX_PAGE_SIZE,
  type SubmissionDetailDto,
  SubmissionPageDto,
  SubmissionQueryDto,
  type SubmissionSummaryDto,
} from './submissions.dto';

const DEFAULT_PAGE_SIZE = 25;

type SummaryRow = Prisma.SubmissionGetPayload<{
  include: { conference: { select: { id: true; code: true; name: true; editionYear: true } } };
}>;

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
    status: row.status,
    memberMatch: null,
    billingStatus: null,
    language: row.language,
    authorCount: row.authorCount,
    receivedAt: row.receivedAt.toISOString(),
  };
}

/**
 * The submissions of the organisation, read only (M3-BE-07; FR-SUB-02, FR-SUB-04): a paged
 * list, newest first, and one submission with everything that exists about it so far. Its
 * files are downloaded by the endpoint that decides by the owning submission and the kind
 * of the file (ADR-10, FR-FILE-02): an admin of the organisation, and only a clean file.
 */
@Injectable()
export class SubmissionsService {
  constructor(private readonly database: TenantDatabase) {}

  async list(query: SubmissionQueryDto): Promise<SubmissionPageDto> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.SubmissionWhereInput =
      query.conferenceId === undefined ? {} : { conferenceId: query.conferenceId };
    const [total, rows] = await this.database.transaction((tx) =>
      Promise.all([
        tx.submission.count({ where }),
        tx.submission.findMany({
          where,
          include: {
            conference: { select: { id: true, code: true, name: true, editionYear: true } },
          },
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
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
          statuses: {
            orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
          },
          messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
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
          scanFlag: file.scanFlag,
          scannedAt: file.scannedAt?.toISOString() ?? null,
          pendingSince:
            file.scanState === 'pending' ? (file.attachedAt ?? file.createdAt).toISOString() : null,
          sha256: file.sha256,
        })),
        consent: {
          text: row.consentText,
          links,
          version: row.consentVersion,
          consentedAt: row.consentedAt.toISOString(),
        },
        statusHistory: row.statuses.map((status) => ({
          status: status.status,
          changedAt: status.changedAt.toISOString(),
          actor: actors.find((actor) => actor.id === status.actorUserId) ?? null,
        })),
        emails: row.messages.map((message) => ({
          id: message.id,
          kind: message.kind,
          recipient: message.recipientAddress,
          status: message.status,
          heldReason: message.heldReason,
          lastErrorCode: message.lastErrorCode,
          createdAt: message.createdAt.toISOString(),
          sentAt: message.sentAt?.toISOString() ?? null,
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

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

@AdminController('submissions')
export class SubmissionsController {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly storage: FileStorage,
  ) {}

  /** The submissions of the organisation, newest first, a page at a time (FR-SUB-02). */
  @Get()
  @Permission('submissions.read')
  listSubmissions(@Query() query: SubmissionQueryDto): Promise<SubmissionPageDto> {
    return this.submissions.list(query);
  }

  /** One submission with its data, files, status history and emails (FR-SUB-04). */
  @Get(':id')
  @Permission('submissions.read')
  getSubmission(@Param('id', ID) id: string): Promise<SubmissionDetailDto> {
    return this.submissions.detail(id);
  }

  /**
   * A file of the submission, as an attachment with a safe name (ADR-10, ST-39). 409
   * `scan_pending` until the virus scan is clean, `file_not_clean` when it is not.
   */
  @Get(':id/files/:fileId')
  @Permission('submissions.read')
  async downloadSubmissionFile(
    @Param('id', ID) id: string,
    @Param('fileId', ID) fileId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.submissions.file(id, fileId);
    response.setHeader('Content-Type', MEDIA_TYPES[file.detectedType as FileType]);
    response.setHeader('Content-Disposition', attachmentHeader(file.originalName));
    response.setHeader('Content-Length', String(file.sizeBytes));
    return new StreamableFile(this.storage.read(file.storageKey));
  }
}

@Module({
  imports: [FilesModule],
  controllers: [SubmissionsController],
  providers: [SubmissionsService],
})
export class SubmissionsModule {}
