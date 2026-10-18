import {
  Body,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminController } from '../../common/http/surface';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import { attachmentHeader } from '../files/file-names';
import { MEDIA_TYPES } from '../files/file-type';
import { FilesModule } from '../files/files.module';
import { FileStorage } from '../files/storage';
import type { FileType } from '../forms/catalogue';
import { SubmissionChangesService } from './submission-changes.service';
import {
  NoteDto,
  StatusChangeDto,
  StatusEmailPreviewDto,
  StatusTextsDto,
  SubmissionDetailDto,
  SubmissionEditDto,
  SubmissionNoteDto,
  SubmissionPageDto,
  SubmissionQueryDto,
} from './submissions.dto';
import { SubmissionsService } from './submissions.service';

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

/**
 * The submissions of the organisation (FR-SUB-02 to 08): the table, one submission, its
 * files, and the changes an admin makes. Reading changes nothing (ST-43): the move from
 * New to Open (transition 2) is a POST that the detail screen sends once it is shown.
 */
@AdminController('submissions')
export class SubmissionsController {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly changes: SubmissionChangesService,
    private readonly storage: FileStorage,
  ) {}

  /**
   * The submissions of the organisation, a page at a time (FR-SUB-02, FR-SUB-03): searched
   * without diacritics, filtered, in one of the fixed orders. Withdrawn ones only on request.
   */
  @Get()
  @Permission('submissions.read')
  listSubmissions(@Query() query: SubmissionQueryDto): Promise<SubmissionPageDto> {
    return this.submissions.list(query);
  }

  /** One submission with everything about it (FR-SUB-04). Changes nothing. */
  @Get(':id')
  @Permission('submissions.read')
  getSubmission(@Param('id', ID) id: string): Promise<SubmissionDetailDto> {
    return this.submissions.detail(id);
  }

  /**
   * The email a change of status would send (FR-MAIL-08), rendered by the server with the
   * images embedded, and its hash. Nothing changes and nothing is queued.
   */
  @Post(':id/status/preview')
  @Permission('submissions.manage')
  @HttpCode(200)
  previewStatusEmail(
    @Param('id', ID) id: string,
    @Body() body: StatusTextsDto,
  ): Promise<StatusEmailPreviewDto> {
    return this.changes.preview(id, body);
  }

  /**
   * A change of status by the state table of Spec section 5 (FR-SUB-05): 409
   * `transition_refused` for a change the table does not have, `version_conflict` for a
   * stale or repeated request, `preview_outdated` when the email is no longer the one shown.
   * Its email is queued in the same transaction, unless the conference switched it off.
   */
  @Post(':id/status')
  @Permission('submissions.manage')
  @HttpCode(200)
  async changeSubmissionStatus(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: StatusChangeDto,
  ): Promise<SubmissionDetailDto> {
    await this.changes.change(access, id, body);
    return this.submissions.detail(id);
  }

  /** A note of an admin (FR-SUB-07): never shown to authors or reviewers. */
  @Post(':id/notes')
  @Permission('submissions.manage')
  addSubmissionNote(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: NoteDto,
  ): Promise<SubmissionNoteDto> {
    return this.changes.addNote(access, id, body);
  }

  /**
   * A correction of the data on the author's behalf (FR-SUB-06): the answers that change,
   * checked like a submit; the old values are kept as a revision. Sends no email: the
   * return to processing after a revision is the status change `resume`.
   */
  @Put(':id')
  @Permission('submissions.manage')
  async editSubmission(
    @CurrentAccess() access: Access,
    @Param('id', ID) id: string,
    @Body() body: SubmissionEditDto,
  ): Promise<SubmissionDetailDto> {
    await this.changes.edit(access, id, body);
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
  providers: [SubmissionsService, SubmissionChangesService],
})
export class SubmissionsModule {}
