/**
 * The email images of the admin API (M4-BE-06). In a file of its own: the OpenAPI compiler
 * plugin reads the classes of `*.dto.ts` files only (Q4-04).
 */

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
