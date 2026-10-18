-- 0.4.0, part 1.
--
-- The staging mail redirect (ADR-27, ST-50): an attempt that went to the mail catcher of a
-- staging instance, and not to the configured server, says so in the mail log. The log
-- keeps the original recipient as before.
ALTER TABLE "mail_log" ADD COLUMN "diverted" BOOLEAN NOT NULL DEFAULT false;

-- A held email can be discarded (M3-ISS-14, UX3-06): its own state, who discarded it and
-- when. It is never sent, and it cannot be released afterwards.
ALTER TABLE "mail_outbox" ADD COLUMN "discarded_at" TIMESTAMPTZ(3),
ADD COLUMN "discarded_by" UUID;

ALTER TABLE "mail_outbox" DROP CONSTRAINT "mail_outbox_status_check";
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_status_check"
    CHECK ("status" IN ('queued', 'sending', 'sent', 'failed', 'held', 'stuck', 'waiting_for_server', 'discarded'));

ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_discarded_check"
    CHECK (("status" = 'discarded') = ("discarded_at" IS NOT NULL AND "discarded_by" IS NOT NULL));

ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organisation_id_discarded_by_fkey"
    FOREIGN KEY ("organisation_id", "discarded_by") REFERENCES "users"("organisation_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
