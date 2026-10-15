-- Mail servers, conferences, templates and the mail log (0.2.0 part B, M2-BE-07 to
-- M2-BE-10): the outbox gains its worker columns.
--
-- Runs as confera_owner. The table and index statements are what `prisma migrate diff`
-- generates from schema.prisma; everything below "Hand-written" is not expressible in
-- Prisma.

-- AlterTable
ALTER TABLE "mail_outbox" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimed_at" TIMESTAMPTZ(3),
ADD COLUMN     "conference_id" UUID,
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "last_error_code" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "sent_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "mail_log_content" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "mail_servers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "tls_mode" TEXT NOT NULL,
    "username" TEXT,
    "password_sealed" TEXT,
    "password_set_at" TIMESTAMPTZ(3),
    "from_address" CITEXT NOT NULL,
    "from_name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "send_rate_per_minute" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "mail_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "edition_year" INTEGER,
    "starts_on" DATE,
    "ends_on" DATE,
    "venue" TEXT,
    "listed_sites" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "time_zone" TEXT NOT NULL DEFAULT 'Europe/Belgrade',
    "state" TEXT NOT NULL DEFAULT 'draft',
    "mail_server_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "conferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "conference_id" UUID,
    "type" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "subject" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "mail_server_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "mail_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "mail_server_id" UUID,
    "server_name" TEXT,
    "recipient" CITEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "conference_id" UUID,
    "attempt" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "error_code" TEXT,
    "subject" TEXT,
    "body_html" TEXT,
    "body_text" TEXT,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_servers_organisation_id_id_key" ON "mail_servers"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conferences_organisation_id_id_key" ON "conferences"("organisation_id", "id");

-- CreateIndex
-- NULLS NOT DISTINCT (hand-edited): one draft without an edition per code, one template
-- of the organisation (no conference) per type and language.
CREATE UNIQUE INDEX "conferences_organisation_id_code_edition_year_key" ON "conferences"("organisation_id", "code", "edition_year") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "mail_templates_organisation_id_id_key" ON "mail_templates"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_templates_organisation_id_conference_id_type_language_key" ON "mail_templates"("organisation_id", "conference_id", "type", "language") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "mail_log_organisation_id_sent_at_idx" ON "mail_log"("organisation_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_log_organisation_id_id_key" ON "mail_log"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "mail_outbox_status_next_attempt_at_idx" ON "mail_outbox"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_organisation_id_mail_server_id_fkey" FOREIGN KEY ("organisation_id", "mail_server_id") REFERENCES "mail_servers"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_organisation_id_conference_id_fkey" FOREIGN KEY ("organisation_id", "conference_id") REFERENCES "conferences"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_organisation_id_mail_server_id_fkey" FOREIGN KEY ("organisation_id", "mail_server_id") REFERENCES "mail_servers"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_organisation_id_message_id_fkey" FOREIGN KEY ("organisation_id", "message_id") REFERENCES "mail_outbox"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organisation_id_conference_id_fkey" FOREIGN KEY ("organisation_id", "conference_id") REFERENCES "conferences"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written
-- ---------------------------------------------------------------------------

-- Closed sets of values.
ALTER TABLE "mail_outbox" DROP CONSTRAINT "mail_outbox_status_check";
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_status_check"
    CHECK ("status" IN ('queued', 'sending', 'sent', 'failed', 'held', 'stuck'));
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_language_check" CHECK ("language" IN ('en', 'sr'));
ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_tls_mode_check"
    CHECK ("tls_mode" IN ('implicit', 'starttls', 'none'));
ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_port_check" CHECK ("port" BETWEEN 1 AND 65535);
ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_send_rate_check" CHECK ("send_rate_per_minute" BETWEEN 1 AND 600);
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_code_check" CHECK ("code" ~ '^[A-Z]{2}$');
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_state_check"
    CHECK ("state" IN ('draft', 'open', 'closed', 'archived'));
ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_language_check" CHECK ("language" IN ('en', 'sr'));
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_result_check" CHECK ("result" IN ('sent', 'failed'));
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_language_check" CHECK ("language" IN ('en', 'sr'));
ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_type_check" CHECK ("type" IN
    ('invitation', 'password_reset', 'email_change_confirmation', 'email_change_notice',
     'security_notice', 'sign_in_brake', 'test_message'));

-- The permissions of this milestone's modules (src/modules/access/permissions.ts).
INSERT INTO "role_permissions" ("role", "permission") VALUES
    ('admin', 'conferences.manage'),
    ('admin', 'conferences.read'),
    ('admin', 'mail_log.read'),
    ('admin', 'mail_servers.manage'),
    ('admin', 'mail_servers.read'),
    ('admin', 'templates.read');

-- The mail log keeps the id of the server a message went through, without a foreign key:
-- the log is history and outlives a deleted server (FR-SMTP-04).

-- Row-level security of the tenant tables, as in the first migration.
ALTER TABLE "mail_servers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_servers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "mail_servers"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "conferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "conferences"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "mail_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "mail_templates"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "mail_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "mail_log"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Grants of the application role.
GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_servers" TO confera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "conferences" TO confera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_templates" TO confera_app;
-- The mail log only grows through the application (FR-SMTP-04); its retention job (0.4.0)
-- gets DELETE when it arrives.
GRANT SELECT, INSERT ON "mail_log" TO confera_app;

-- The system role finds the next outbox rows for the worker (ADR-05: "the claim of a job
-- or outbox row" is a resolver that returns ids); it reads the few columns of the claim and
-- nothing of the message. The claim itself is written inside the organisation, as the
-- application role, under row-level security.
GRANT SELECT ("id", "organisation_id", "status", "next_attempt_at", "claimed_at") ON "mail_outbox" TO confera_system;
