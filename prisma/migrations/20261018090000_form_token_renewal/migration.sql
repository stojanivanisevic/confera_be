-- Fixes of 0.3.0 (Q3-01): a form token may renew a refused one (expired or used) of the
-- same form; the renewal keeps the moment the author began to fill in the form, from which
-- the minimum fill time is measured. The old token is named by id, without a foreign key:
-- expired tokens are purged.

-- AlterTable
ALTER TABLE "form_tokens" ADD COLUMN     "fill_started_at" TIMESTAMPTZ(3),
ADD COLUMN     "renewed_from" UUID;
