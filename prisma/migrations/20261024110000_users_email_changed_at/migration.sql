-- 0.4.0, fix round (SEC-M4-02): when the address of an account last changed by a confirmed
-- email change. A link asked for before it (a reset, an invitation), and a resend from the
-- mail log of such a request, is stale and is not sent. Null for the accounts of before.
-- The application role keeps its grants on "users" (SELECT, INSERT, UPDATE, DELETE).
ALTER TABLE "users" ADD COLUMN "email_changed_at" TIMESTAMPTZ(3);
