-- 0.4.0, part 3: email images (M4-BE-06, ADR-10, ADR-12; ST-60, ST-67). An email image
-- is a private file of its own kind, owned by the organisation, uploaded by an admin and
-- re-encoded on the server (PNG or JPEG; a GIF becomes a PNG of its first frame). It is
-- never attached to a submission, never served without a session, and travels inside a
-- message as an inline part.

ALTER TABLE "files" DROP CONSTRAINT "files_kind_check";
ALTER TABLE "files" ADD CONSTRAINT "files_kind_check"
    CHECK ("kind" IN ('submission_file', 'email_image'));

-- The pixel size of an image as it was stored (after re-encoding): what the email shows.
ALTER TABLE "files" ADD COLUMN "width" INTEGER,
ADD COLUMN "height" INTEGER;

ALTER TABLE "files" ADD CONSTRAINT "files_email_image_check"
    CHECK ("kind" <> 'email_image' OR (
      "submission_id" IS NULL AND "form_token_id" IS NULL AND "field_key" IS NULL
      AND "detected_type" IN ('png', 'jpeg')
      AND "width" BETWEEN 1 AND 600 AND "height" BETWEEN 1 AND 4000
      AND "size_bytes" <= 204800));
ALTER TABLE "files" ADD CONSTRAINT "files_dimensions_check"
    CHECK (("width" IS NULL) = ("height" IS NULL));

CREATE INDEX "files_organisation_id_kind_created_at_idx" ON "files"("organisation_id", "kind", "created_at");
