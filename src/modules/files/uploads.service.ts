import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import busboy from 'busboy';
import type { Request } from 'express';
import { ProblemException } from '../../common/http/problem';
import { AppLogger } from '../../common/logging/app-logger';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { fileFieldsOf, parseDefinition } from '../forms/definition';
import { IntakeService } from '../forms/intake.service';
import type { UploadedFileDto } from '../forms/forms.dto';
import { PublicLimits } from '../forms/public-limits';
import { MailQueue } from '../mail/mail-queue';
import { safeFileName } from './file-names';
import { detectFileType } from './file-type';
import { FileStorage } from './storage';

/**
 * The upload of one file of a public form (ADR-10, M3-BE-04; FR-FILE-01, FR-FORM-10,
 * NFR-SEC-06; ST-32, ST-33). Multipart only, with two parts in this order: `field` (the key
 * of a file field of the form version) and `file`. The header `X-Form-Token` names the token.
 *
 * - The token must be valid for this form, and allows only as many uploads as the version
 *   has file fields, plus a margin.
 * - The field's own limit applies at once: the body is streamed to the private storage and
 *   cut off one byte beyond it (413 `file_too_large`); the SHA-256 is computed on the way.
 * - The type is read from the content (415 `file_type_refused` for anything the field does
 *   not accept); a `.docx` with macros is refused (422 `docx_macros`, G2-22); an old `.doc`
 *   with macros is kept and flagged.
 * - Above the quota of unattached bytes of the organisation uploads are refused (503
 *   `upload_quota_reached`) and the admins are told, once an hour.
 * - The file waits, unattached and unscanned, until the submit attaches it; the purge removes
 *   it when its token expires.
 */
export const UNATTACHED_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/** The original name is kept to this many bytes of its header part. */
const MAX_NAME_BYTES = 1024;

interface Received {
  readonly field: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

@Injectable()
export class UploadsService {
  /** The quota of unattached bytes of an organisation; a test lowers it. */
  quotaBytes = UNATTACHED_QUOTA_BYTES;

  constructor(
    private readonly intake: IntakeService,
    private readonly database: TenantDatabase,
    private readonly storage: FileStorage,
    private readonly limits: PublicLimits,
    private readonly mail: MailQueue,
    private readonly logger: AppLogger,
  ) {}

  async upload(
    slug: string,
    token: string | undefined,
    request: Request,
    address: string,
  ): Promise<UploadedFileDto> {
    if (!this.limits.takeUpload(address)) {
      throw new ProblemException(429, 'too_many_requests');
    }
    return this.intake.inForm(slug, async (resolved) => {
      const now = new Date();
      // The token, its allowance and the field: decided before a byte of the file is read.
      const prepared = await this.database.transaction(async (tx) => {
        const row = await this.intake.validToken(tx, resolved.formId, token, now);
        const version = await tx.formVersion.findUniqueOrThrow({
          where: { id: row.formVersionId },
        });
        const definition = parseDefinition(version.definition);
        const allowance = this.intake.uploadAllowance(definition);
        const counted = await tx.formToken.updateMany({
          where: { id: row.id, uploads: { lt: allowance } },
          data: { uploads: { increment: 1 } },
        });
        if (counted.count !== 1) {
          throw new ProblemException(429, 'too_many_uploads');
        }
        const unattached = await tx.storedFile.aggregate({
          where: { submissionId: null },
          _sum: { sizeBytes: true },
        });
        if ((unattached._sum.sizeBytes ?? 0) >= this.quotaBytes) {
          await this.mail.noticeToAdmins(
            tx,
            resolved.organisationId,
            'upload_quota_reached',
            {},
            `upload_quota_reached:${now.toISOString().slice(0, 13)}`,
          );
          return { quotaReached: true as const };
        }
        return { quotaReached: false as const, tokenId: row.id, fields: fileFieldsOf(definition) };
      });
      if (prepared.quotaReached) {
        throw new ProblemException(503, 'upload_quota_reached');
      }

      const largest = Math.max(0, ...prepared.fields.map((f) => f.rules.file?.maxBytes ?? 0));
      const received = await this.receive(
        request,
        (key) => {
          const field = prepared.fields.find((candidate) => candidate.key === key);
          return field?.rules.file?.maxBytes ?? null;
        },
        largest,
      );
      try {
        const field = prepared.fields.find((candidate) => candidate.key === received.field);
        const accept = field?.rules.file?.accept ?? [];
        const detected = await detectFileType(received.path);
        if (detected.type === null || !accept.includes(detected.type)) {
          throw new ProblemException(415, 'file_type_refused');
        }
        if (detected.type === 'docx' && detected.macros) {
          throw new ProblemException(422, 'docx_macros');
        }
        const key = this.storage.newKey(resolved.organisationId);
        const name = safeFileName(received.name, detected.type);
        await this.storage.keep(received.path, key);
        const stored = await this.database.db.storedFile.create({
          data: {
            organisationId: resolved.organisationId,
            kind: 'submission_file',
            storageKey: key,
            originalName: name,
            detectedType: detected.type,
            sizeBytes: received.size,
            sha256: received.sha256,
            scanFlag: detected.type === 'doc' && detected.macros ? 'macros' : null,
            formTokenId: prepared.tokenId,
            fieldKey: received.field,
          },
        });
        return { fileId: stored.id, name, sizeBytes: received.size, type: detected.type };
      } finally {
        await this.storage.removeTemporary(received.path);
      }
    });
  }

  /**
   * Streams the request's multipart body to a temporary file of the storage: the part
   * `field` first, then `file`, which is cut off one byte beyond the field's limit.
   */
  private receive(
    request: Request,
    limitOf: (field: string) => number | null,
    largest: number,
  ): Promise<Received> {
    return new Promise<Received>((resolvePromise, rejectPromise) => {
      let parser: busboy.Busboy;
      try {
        parser = busboy({
          headers: request.headers,
          limits: {
            files: 1,
            fields: 1,
            parts: 2,
            fieldSize: 100,
            fieldNameSize: 20,
            // One byte beyond the largest field limit: busboy stops reading there.
            fileSize: largest + 1,
          },
          defParamCharset: 'utf8',
        });
      } catch {
        rejectPromise(new ProblemException(415, 'unsupported_media_type'));
        return;
      }
      let field: string | null = null;
      let settled = false;
      let pending: Promise<Received> | null = null;
      const fail = (error: ProblemException): void => {
        if (!settled) {
          settled = true;
          request.unpipe(parser);
          request.resume();
          rejectPromise(error);
        }
      };
      parser.on('field', (name, value) => {
        if (name === 'field' && /^[a-z][A-Za-z]{0,40}$/.test(value)) {
          field = value;
        } else {
          fail(new ProblemException(400, 'upload_field_unknown'));
        }
      });
      parser.on('file', (name, stream, info) => {
        const limit = field === null ? null : limitOf(field);
        if (name !== 'file' || field === null || limit === null) {
          stream.resume();
          fail(new ProblemException(400, 'upload_field_unknown'));
          return;
        }
        const chosenField = field;
        // Browsers write a quote and a line break of a file name as %22, %0D and %0A in the
        // part's header (WHATWG multipart); the name is cleaned afterwards in any case.
        const original = Buffer.from(info.filename, 'utf8')
          .subarray(0, MAX_NAME_BYTES)
          .toString('utf8')
          .replace(/%22/gi, '"')
          .replace(/%0[AD]/gi, '');
        pending = (async () => {
          const path = await this.storage.temporaryPath();
          const hash = createHash('sha256');
          let size = 0;
          let tooLarge = false;
          const out = this.storage.writeStream(path);
          await new Promise<void>((done, broke) => {
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit) {
                tooLarge = true;
                stream.resume();
                return;
              }
              hash.update(chunk);
              if (!out.write(chunk)) {
                stream.pause();
                out.once('drain', () => stream.resume());
              }
            });
            stream.on('end', () => out.end(() => done()));
            stream.on('error', broke);
            out.on('error', broke);
          });
          if (tooLarge || (stream as { truncated?: boolean }).truncated === true) {
            await this.storage.removeTemporary(path);
            throw new ProblemException(413, 'file_too_large');
          }
          return {
            field: chosenField,
            name: original,
            path,
            size,
            sha256: hash.digest('hex'),
          };
        })();
        // Settled when the parser closes; until then a refusal must not count as unhandled.
        pending.catch(() => undefined);
      });
      parser.on('error', () => {
        fail(new ProblemException(400, 'upload_broken'));
      });
      parser.on('close', () => {
        if (settled) {
          return;
        }
        if (pending === null) {
          fail(new ProblemException(400, 'upload_file_missing'));
          return;
        }
        settled = true;
        pending.then(resolvePromise, (error: unknown) => {
          rejectPromise(
            error instanceof ProblemException ? error : new ProblemException(400, 'upload_broken'),
          );
          if (!(error instanceof ProblemException)) {
            this.logger.warn('upload.failed', {
              error: error instanceof Error ? error.name : 'unknown',
            });
          }
        });
      });
      request.on('aborted', () => {
        fail(new ProblemException(400, 'upload_broken'));
      });
      request.pipe(parser);
    });
  }
}
