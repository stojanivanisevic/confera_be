-- Fixes of the 0.3.0 UX review (UX3-06): a held email keeps the numbers of its hold, so the
-- office reads which limit, the count and the window ("4 in 1 hour, limit 3"). No new state.

-- AlterTable
ALTER TABLE "mail_outbox" ADD COLUMN     "held_count" INTEGER,
ADD COLUMN     "held_limit" INTEGER,
ADD COLUMN     "held_window_hours" INTEGER;

ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_held_numbers_check"
  CHECK (
    ("held_count" IS NULL AND "held_limit" IS NULL AND "held_window_hours" IS NULL)
    OR ("held_reason" IS NOT NULL AND "held_count" > "held_limit" AND "held_limit" >= 1
        AND "held_window_hours" IN (1, 24))
  );
