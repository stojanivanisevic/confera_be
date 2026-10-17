import { Body, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { clientAddress } from '../../common/http/client-address';
import { ProblemException } from '../../common/http/problem';
import { PublicController } from '../../common/http/surface';
import { Public } from '../access/access.decorators';
import { UploadsService } from '../files/uploads.service';
import {
  FormTokenDto,
  FormTokenRequestDto,
  FrameSitesDto,
  PublicFormDto,
  SubmitDto,
  SubmittedDto,
  UploadedFileDto,
} from './forms.dto';
import { IntakeService } from './intake.service';
import { NoPrototypeKeysGuard, OwnPage } from './own-page.guard';

/** The header that carries the form token (ADR-08): a custom header, so a preflight is forced and refused. */
export const FORM_TOKEN_HEADER = 'x-form-token';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The public forms (ADR-08, M3-BE-03, M3-BE-04): read the published form and its frame
 * sites, fetch a form token, upload a file, submit. Under the public host name only.
 */
@PublicController('forms')
export class PublicFormsController {
  constructor(
    private readonly intake: IntakeService,
    private readonly uploads: UploadsService,
  ) {}

  /** The published form: its definition, and whether it is open (FR-FORM-06, FR-DL-02). */
  @Get(':slug')
  @Public()
  getPublicForm(@Param('slug') slug: string): Promise<PublicFormDto> {
    return this.intake.publicForm(slug);
  }

  /**
   * The sites that may frame the form, for `frame-ancestors` of /embed/<slug> (ADR-07): the
   * conference's checked list while it is open for submissions, otherwise none.
   */
  @Get(':slug/frame-sites')
  @Public()
  async getFrameSites(@Param('slug') slug: string): Promise<FrameSitesDto> {
    return { sites: await this.intake.frameSites(slug) };
  }

  /**
   * A single-use form token (ADR-08). Under load it asks for a proof-of-work. JSON only:
   * `{}`, or `{ "previousFormToken": "..." }` to renew a refused token (Q3-01). 409
   * `form_closed` when the form takes no submissions.
   */
  @Post(':slug/tokens')
  @Public()
  @OwnPage('application/json')
  @HttpCode(201)
  issueFormToken(
    @Param('slug') slug: string,
    @Body() body: FormTokenRequestDto,
    @Req() request: Request,
  ): Promise<FormTokenDto> {
    return this.intake.issueToken(slug, clientAddress(request), body.previousFormToken);
  }

  /**
   * One file for a file field (ADR-10): multipart with the parts `field` and `file`, in
   * that order. 413 `file_too_large`, 415 `file_type_refused`, 422 `docx_macros`, 429
   * `too_many_uploads`, 503 `upload_quota_reached`.
   */
  @Post(':slug/uploads')
  @Public()
  @OwnPage('multipart/form-data')
  @HttpCode(201)
  @ApiHeader({ name: 'X-Form-Token', required: true })
  uploadFormFile(@Param('slug') slug: string, @Req() request: Request): Promise<UploadedFileDto> {
    return this.uploads.upload(
      slug,
      header(request, FORM_TOKEN_HEADER),
      request,
      clientAddress(request),
    );
  }

  /**
   * The submit (ADR-08, FR-FORM-14): processed once per `Idempotency-Key`. Refused answers
   * are 400 `validation_failed` with `answers.<path>` and the codes of
   * contracts/form-rule-vectors.json. 403 `form_token_invalid` or `proof_of_work_failed`,
   * 409 `form_token_used`, `form_closed` or `idempotency_key_reused`, 429 `too_many_requests`.
   */
  @Post(':slug/submissions')
  @Public()
  @OwnPage('application/json')
  @UseGuards(NoPrototypeKeysGuard)
  @HttpCode(201)
  @ApiHeader({ name: 'X-Form-Token', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'A UUID per form instance.' })
  submitForm(
    @Param('slug') slug: string,
    @Body() body: SubmitDto,
    @Req() request: Request,
  ): Promise<SubmittedDto> {
    const key = header(request, IDEMPOTENCY_HEADER);
    if (key === undefined || !UUID.test(key)) {
      throw new ProblemException(400, 'idempotency_key_missing');
    }
    // The answers as the JSON parser gave them (a key like `__proto__` was refused before).
    const raw = (request.body as { answers?: unknown } | undefined)?.answers;
    return this.intake.submit({
      slug,
      address: clientAddress(request),
      token: header(request, FORM_TOKEN_HEADER),
      idempotencyKey: key.toLowerCase(),
      language: body.language,
      answers: raw,
      trap: body.website,
      proofOfWork: body.proofOfWork,
    });
  }
}
