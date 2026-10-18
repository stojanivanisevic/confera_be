-- 0.4.0, part 4: the mail log (M4-BE-05; FR-SMTP-05, FR-SMTP-06).

-- A resend is a message of its own that names the one it repeats, and says how it was made:
-- `copy` (the content as it was sent, with a fresh secure link) or `rendered_again` (the
-- content was not kept, so the template was rendered again).
ALTER TABLE "mail_outbox" ADD COLUMN "resend_of" UUID,
ADD COLUMN "resend_mode" TEXT;
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_resend_check"
    CHECK (("resend_of" IS NULL) = ("resend_mode" IS NULL)
       AND ("resend_mode" IS NULL OR "resend_mode" IN ('copy', 'rendered_again')));
CREATE INDEX "mail_outbox_organisation_id_resend_of_idx" ON "mail_outbox"("organisation_id", "resend_of");

-- How long the mail log keeps its entries (FR-SMTP-06, SA-19): 24 months on a fresh install.
ALTER TABLE "organisations" ADD COLUMN "mail_log_retention_days" INTEGER NOT NULL DEFAULT 730;
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_mail_log_retention_days_check"
    CHECK ("mail_log_retention_days" BETWEEN 30 AND 3650);

-- The retention job removes what is older than that: log entries, and the messages that are
-- done with (sent, failed, discarded, stuck), with their content. Nothing else is deleted.
GRANT DELETE ON "mail_log" TO confera_app;
GRANT DELETE ON "mail_outbox" TO confera_app;
CREATE INDEX "mail_outbox_organisation_id_status_created_at_idx"
    ON "mail_outbox"("organisation_id", "status", "created_at");
