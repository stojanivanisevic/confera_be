import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  Get,
  HttpStatus,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import busboy from 'busboy';
import type { Request, Response } from 'express';
import { ProblemException } from '../../common/http/problem';
import { AdminController } from '../../common/http/surface';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { CurrentAccess, Permission } from '../access/access.decorators';
import { AuditRecorder } from '../audit/audit-recorder';
import { ImageError, MAX_UPLOAD_BYTES, processEmailImage } from './email-images';
import { attachmentHeader, safeFileName } from './file-names';
import { FilesModule } from './files.module';
import { mayServe } from './serving';
import { FileStorage } from './storage';

/** Email images an organisation may keep (P): far above what its templates can show. */
export const MAX_IMAGES_PER_ORGANISATION = 500;

/** An email image (M4-BE-06): re-encoded, private, shown in templates once its scan is clean. */
export class MailImageDto {
  id!: string;
  /** The name it was uploaded under, cleaned (with the extension of what it is now). */
  name!: string;
  /** What it is now: png or jpeg (a GIF became a PNG of its first frame). */
  type!: string;
  width!: number;
  height!: number;
  sizeBytes!: number;
  /** pending until ClamAV has said clean; only a clean image is shown or sent. */
  scanState!: string;
  createdAt!: string;
}

export class MailImageListDto {
  items!: MailImageDto[];
}

type FileRow = Prisma.StoredFileGetPayload<object>;

function toDto(row: FileRow): MailImageDto {
  return {
    id: row.id,
    name: row.originalName,
    type: row.detectedType,
    width: row.width ?? 0,
    height: row.height ?? 0,
    sizeBytes: row.sizeBytes,
    scanState: row.scanState,
    createdAt: row.createdAt.toISOString(),
  };
}

const REFUSAL_STATUS: Readonly<Record<ImageError['code'], number>> = {
  image_type_refused: 415,
  image_too_many_pixels: 422,
  image_unreadable: 422,
  image_too_large: 413,
};

/**
 * Email images (M4-BE-06; ADR-10, ADR-12; ST-60, ST-67): uploaded by an admin, typed by
 * content, re-encoded in a worker (email-images.ts), stored privately as their own file
 * kind and scanned. They are served only to a signed-in admin of the organisation, and sent
 * only inside a message as inline parts; there is no public address of an image.
 */
@Injectable()
export class MailImagesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly storage: FileStorage,
    private readonly audit: AuditRecorder,
  ) {}

  async upload(actor: Access, request: Request): Promise<MailImageDto> {
    const kept = await this.database.db.storedFile.count({ where: { kind: 'email_image' } });
    if (kept >= MAX_IMAGES_PER_ORGANISATION) {
      throw new ProblemException(409, 'image_quota_reached');
    }
    const received = await this.receive(request);
    let encoded;
    try {
      encoded = await processEmailImage(received.bytes);
    } catch (error) {
      if (error instanceof ImageError) {
        throw new ProblemException(REFUSAL_STATUS[error.code], error.code);
      }
      throw error;
    }
    const temporary = await this.storage.temporaryPath();
    const key = this.storage.newKey(actor.organisationId);
    try {
      await writeFile(temporary, encoded.bytes, { flag: 'wx' });
      await this.storage.keep(temporary, key);
    } catch (error) {
      await this.storage.removeTemporary(temporary);
      throw error;
    }
    try {
      return await this.database.transaction(async (tx) => {
        const row = await tx.storedFile.create({
          data: {
            organisationId: actor.organisationId,
            kind: 'email_image',
            storageKey: key,
            originalName: safeFileName(received.name, encoded.type),
            detectedType: encoded.type,
            width: encoded.width,
            height: encoded.height,
            sizeBytes: encoded.bytes.length,
            sha256: createHash('sha256').update(encoded.bytes).digest('hex'),
          },
        });
        await this.audit.record(tx, {
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          action: 'mail_image.uploaded',
          subjectType: 'mail_image',
          subjectId: row.id,
        });
        return toDto(row);
      });
    } catch (error) {
      await this.storage.remove(key);
      throw error;
    }
  }

  async list(): Promise<MailImageListDto> {
    const rows = await this.database.db.storedFile.findMany({
      where: { kind: 'email_image' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: rows.map(toDto) };
  }

  /** The image itself, for the editor: an admin of its organisation, and a clean scan only. */
  async file(id: string): Promise<FileRow> {
    const file = await this.database.db.storedFile.findFirst({
      where: { id, kind: 'email_image' },
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

  /** One part `file`, at most 5 MB (413 beyond), read into memory: an image is small. */
  private receive(request: Request): Promise<{ name: string; bytes: Buffer }> {
    return new Promise((resolve, reject) => {
      let parser: busboy.Busboy;
      try {
        parser = busboy({
          headers: request.headers,
          limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_UPLOAD_BYTES + 1 },
          defParamCharset: 'utf8',
        });
      } catch {
        reject(new ProblemException(415, 'unsupported_media_type'));
        return;
      }
      let settled = false;
      const fail = (error: ProblemException): void => {
        if (!settled) {
          settled = true;
          request.unpipe(parser);
          request.resume();
          reject(error);
        }
      };
      let result: { name: string; bytes: Buffer } | null = null;
      parser.on('file', (field, stream, info) => {
        if (field !== 'file') {
          stream.resume();
          fail(new ProblemException(400, 'upload_field_unknown'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (piece: Buffer) => {
          size += piece.length;
          if (size <= MAX_UPLOAD_BYTES) {
            chunks.push(piece);
          }
        });
        stream.on('end', () => {
          if (size > MAX_UPLOAD_BYTES || (stream as { truncated?: boolean }).truncated === true) {
            fail(new ProblemException(413, 'image_too_large'));
            return;
          }
          result = { name: info.filename.slice(0, 300), bytes: Buffer.concat(chunks) };
        });
      });
      parser.on('field', () => {
        fail(new ProblemException(400, 'upload_field_unknown'));
      });
      parser.on('error', () => {
        fail(new ProblemException(400, 'upload_broken'));
      });
      parser.on('close', () => {
        if (settled) {
          return;
        }
        settled = true;
        if (result === null) {
          reject(new ProblemException(400, 'upload_file_missing'));
          return;
        }
        resolve(result);
      });
      request.on('aborted', () => {
        fail(new ProblemException(400, 'upload_broken'));
      });
      request.pipe(parser);
    });
  }
}

const ID = new ParseUUIDPipe({ version: '4', errorHttpStatusCode: HttpStatus.NOT_FOUND });

@AdminController('mail-images')
export class MailImagesController {
  constructor(
    private readonly images: MailImagesService,
    private readonly storage: FileStorage,
  ) {}

  /**
   * Uploads an email image: multipart, one part `file`, at most 5 MB. PNG, JPEG or GIF by
   * content (415 `image_type_refused` otherwise, SVG included); at most 8,000 pixels a side
   * and 16 megapixels by its header (422 `image_too_many_pixels`); 422 `image_unreadable`
   * when it cannot be decoded in time; re-encoded at most 600 pixels wide and 200 KB (413
   * `image_too_large`). Its scan is pending until ClamAV says clean.
   */
  @Post()
  @Permission('templates.manage')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  uploadMailImage(@CurrentAccess() access: Access, @Req() request: Request): Promise<MailImageDto> {
    return this.images.upload(access, request);
  }

  /** The email images of the organisation, newest first. */
  @Get()
  @Permission('templates.read')
  listMailImages(): Promise<MailImageListDto> {
    return this.images.list();
  }

  /**
   * One image, to a signed-in admin of its organisation only, and only once its scan is clean
   * (409 `scan_pending`, `file_not_clean`); as an attachment with its fixed type, never sniffed.
   */
  @Get(':id')
  @Permission('templates.read')
  async getMailImage(
    @Param('id', ID) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.images.file(id);
    response.setHeader('Content-Type', file.detectedType === 'jpeg' ? 'image/jpeg' : 'image/png');
    response.setHeader('Content-Disposition', attachmentHeader(file.originalName));
    response.setHeader('Content-Length', String(file.sizeBytes));
    return new StreamableFile(this.storage.read(file.storageKey));
  }
}

@Module({
  imports: [FilesModule],
  controllers: [MailImagesController],
  providers: [MailImagesService],
})
export class MailImagesModule {}
