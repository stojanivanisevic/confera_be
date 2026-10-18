-- Fixes of the 0.3.0 security review (SEC-M3-02): a live form token is never renewed. A
-- token whose submit the proof-of-work refused is no longer live, although it has not
-- expired, and the page renews it (Q3-02); this column says when that happened.

-- AlterTable
ALTER TABLE "form_tokens" ADD COLUMN     "refused_at" TIMESTAMPTZ(3);
