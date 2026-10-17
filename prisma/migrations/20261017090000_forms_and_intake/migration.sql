-- Forms, embed and intake (0.3.0, M3-BE-01 to M3-BE-09): forms and their immutable
-- versions, single-use form tokens, deadlines with their history, submissions with their
-- authors and status history, stored files with their scan state, and the columns of the
-- send breaker on the outbox.
--
-- Runs as confera_owner. The table and index statements are what `prisma migrate diff`
-- generates from schema.prisma; everything below "Hand-written" is not expressible in
-- Prisma.

-- AlterTable
ALTER TABLE "conferences" ADD COLUMN     "privacy_notice_url" TEXT,
ADD COLUMN     "publication_terms_url" TEXT,
ADD COLUMN     "submission_counter" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "mail_outbox" ADD COLUMN     "form_id" UUID,
ADD COLUMN     "held_reason" TEXT,
ADD COLUMN     "released_at" TIMESTAMPTZ(3),
ADD COLUMN     "released_by" UUID,
ADD COLUMN     "submission_id" UUID;

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "breaker_per_day" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "breaker_per_hour" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "forms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "conference_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "current_version_id" UUID,
    "breaker_per_hour" INTEGER NOT NULL DEFAULT 30,
    "breaker_per_day" INTEGER NOT NULL DEFAULT 200,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,

    CONSTRAINT "form_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "form_version_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "uploads" INTEGER NOT NULL DEFAULT 0,
    "pow_challenge" TEXT,
    "pow_difficulty" INTEGER,

    CONSTRAINT "form_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conference_deadlines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "conference_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "ends_on" DATE NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "conference_deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conference_deadline_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "conference_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "old_ends_on" DATE,
    "new_ends_on" DATE NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" UUID,

    CONSTRAINT "conference_deadline_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "conference_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "form_version_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "answers" JSONB NOT NULL,
    "title" TEXT,
    "participation_type" TEXT,
    "first_author_name" TEXT NOT NULL,
    "first_author_institution" TEXT,
    "corresponding_email" CITEXT NOT NULL,
    "corresponding_domain" CITEXT NOT NULL,
    "author_count" INTEGER NOT NULL,
    "consent_text" TEXT NOT NULL,
    "consent_links" JSONB NOT NULL DEFAULT '{}',
    "consent_version" TEXT NOT NULL,
    "consented_at" TIMESTAMPTZ(3) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_authors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "institution" TEXT,
    "institution_address" TEXT,
    "orcid" TEXT,
    "email" CITEXT NOT NULL,
    "phone" TEXT,
    "is_corresponding" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "submission_authors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,

    CONSTRAINT "submission_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "detected_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "scan_state" TEXT NOT NULL DEFAULT 'pending',
    "scan_flag" TEXT,
    "scan_detail" TEXT,
    "scan_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_scan_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scanned_at" TIMESTAMPTZ(3),
    "form_token_id" UUID,
    "field_key" TEXT,
    "submission_id" UUID,
    "attached_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "forms_public_key_key" ON "forms"("public_key");

-- CreateIndex
CREATE UNIQUE INDEX "forms_organisation_id_id_key" ON "forms"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "forms_organisation_id_conference_id_type_key" ON "forms"("organisation_id", "conference_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "form_versions_organisation_id_id_key" ON "form_versions"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "form_versions_organisation_id_form_id_number_key" ON "form_versions"("organisation_id", "form_id", "number");

-- CreateIndex
CREATE INDEX "form_tokens_organisation_id_expires_at_idx" ON "form_tokens"("organisation_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "form_tokens_organisation_id_id_key" ON "form_tokens"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "form_tokens_organisation_id_token_hash_key" ON "form_tokens"("organisation_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "conference_deadlines_organisation_id_id_key" ON "conference_deadlines"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conference_deadlines_organisation_id_conference_id_kind_key" ON "conference_deadlines"("organisation_id", "conference_id", "kind");

-- CreateIndex
CREATE INDEX "conference_deadline_changes_organisation_id_conference_id_c_idx" ON "conference_deadline_changes"("organisation_id", "conference_id", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "conference_deadline_changes_organisation_id_id_key" ON "conference_deadline_changes"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "submissions_organisation_id_received_at_idx" ON "submissions"("organisation_id", "received_at");

-- CreateIndex
CREATE INDEX "submissions_organisation_id_conference_id_received_at_idx" ON "submissions"("organisation_id", "conference_id", "received_at");

-- CreateIndex
CREATE INDEX "submissions_organisation_id_corresponding_domain_received_a_idx" ON "submissions"("organisation_id", "corresponding_domain", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_organisation_id_id_key" ON "submissions"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_organisation_id_reference_key" ON "submissions"("organisation_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_organisation_id_form_id_idempotency_key_key" ON "submissions"("organisation_id", "form_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "submission_authors_organisation_id_id_key" ON "submission_authors"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_authors_organisation_id_submission_id_position_key" ON "submission_authors"("organisation_id", "submission_id", "position");

-- CreateIndex
CREATE INDEX "submission_status_history_organisation_id_submission_id_cha_idx" ON "submission_status_history"("organisation_id", "submission_id", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "submission_status_history_organisation_id_id_key" ON "submission_status_history"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "files"("storage_key");

-- CreateIndex
CREATE INDEX "files_organisation_id_submission_id_idx" ON "files"("organisation_id", "submission_id");

-- CreateIndex
CREATE INDEX "files_organisation_id_form_token_id_idx" ON "files"("organisation_id", "form_token_id");

-- CreateIndex
CREATE INDEX "files_organisation_id_scan_state_next_scan_at_idx" ON "files"("organisation_id", "scan_state", "next_scan_at");

-- CreateIndex
CREATE UNIQUE INDEX "files_organisation_id_id_key" ON "files"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "mail_outbox_organisation_id_form_id_created_at_idx" ON "mail_outbox"("organisation_id", "form_id", "created_at");

-- CreateIndex
CREATE INDEX "mail_outbox_organisation_id_submission_id_idx" ON "mail_outbox"("organisation_id", "submission_id");

-- AddForeignKey
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organisation_id_form_id_fkey" FOREIGN KEY ("organisation_id", "form_id") REFERENCES "forms"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organisation_id_submission_id_fkey" FOREIGN KEY ("organisation_id", "submission_id") REFERENCES "submissions"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_organisation_id_conference_id_fkey" FOREIGN KEY ("organisation_id", "conference_id") REFERENCES "conferences"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_organisation_id_current_version_id_fkey" FOREIGN KEY ("organisation_id", "current_version_id") REFERENCES "form_versions"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_organisation_id_form_id_fkey" FOREIGN KEY ("organisation_id", "form_id") REFERENCES "forms"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_organisation_id_published_by_fkey" FOREIGN KEY ("organisation_id", "published_by") REFERENCES "users"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_tokens" ADD CONSTRAINT "form_tokens_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_tokens" ADD CONSTRAINT "form_tokens_organisation_id_form_id_fkey" FOREIGN KEY ("organisation_id", "form_id") REFERENCES "forms"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_tokens" ADD CONSTRAINT "form_tokens_organisation_id_form_version_id_fkey" FOREIGN KEY ("organisation_id", "form_version_id") REFERENCES "form_versions"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conference_deadlines" ADD CONSTRAINT "conference_deadlines_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conference_deadlines" ADD CONSTRAINT "conference_deadlines_organisation_id_conference_id_fkey" FOREIGN KEY ("organisation_id", "conference_id") REFERENCES "conferences"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conference_deadline_changes" ADD CONSTRAINT "conference_deadline_changes_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conference_deadline_changes" ADD CONSTRAINT "conference_deadline_changes_organisation_id_conference_id_fkey" FOREIGN KEY ("organisation_id", "conference_id") REFERENCES "conferences"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conference_deadline_changes" ADD CONSTRAINT "conference_deadline_changes_organisation_id_changed_by_fkey" FOREIGN KEY ("organisation_id", "changed_by") REFERENCES "users"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_organisation_id_conference_id_fkey" FOREIGN KEY ("organisation_id", "conference_id") REFERENCES "conferences"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_organisation_id_form_id_fkey" FOREIGN KEY ("organisation_id", "form_id") REFERENCES "forms"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_organisation_id_form_version_id_fkey" FOREIGN KEY ("organisation_id", "form_version_id") REFERENCES "form_versions"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_organisation_id_submission_id_fkey" FOREIGN KEY ("organisation_id", "submission_id") REFERENCES "submissions"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_status_history" ADD CONSTRAINT "submission_status_history_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_status_history" ADD CONSTRAINT "submission_status_history_organisation_id_submission_id_fkey" FOREIGN KEY ("organisation_id", "submission_id") REFERENCES "submissions"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_organisation_id_submission_id_fkey" FOREIGN KEY ("organisation_id", "submission_id") REFERENCES "submissions"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written
-- ---------------------------------------------------------------------------

-- Closed sets of values and bounds.
ALTER TABLE "forms" ADD CONSTRAINT "forms_type_check" CHECK ("type" IN ('abstract'));
ALTER TABLE "forms" ADD CONSTRAINT "forms_public_key_check" CHECK ("public_key" ~ '^[a-z0-9]{16}$');
ALTER TABLE "forms" ADD CONSTRAINT "forms_breaker_check"
    CHECK ("breaker_per_hour" BETWEEN 1 AND 10000 AND "breaker_per_day" BETWEEN 1 AND 100000);
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_breaker_check"
    CHECK ("breaker_per_hour" BETWEEN 1 AND 10000 AND "breaker_per_day" BETWEEN 1 AND 100000);
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_number_check" CHECK ("number" >= 1);
ALTER TABLE "form_tokens" ADD CONSTRAINT "form_tokens_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "conference_deadlines" ADD CONSTRAINT "conference_deadlines_kind_check"
    CHECK ("kind" IN ('abstract_submission', 'fee_payment', 'full_paper'));
ALTER TABLE "conference_deadline_changes" ADD CONSTRAINT "conference_deadline_changes_kind_check"
    CHECK ("kind" IN ('abstract_submission', 'fee_payment', 'full_paper'));
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_consent_links_check"
    CHECK (("publication_terms_url" IS NULL OR "publication_terms_url" ~ '^https://[^\s<>"'']+$')
       AND ("privacy_notice_url" IS NULL OR "privacy_notice_url" ~ '^https://[^\s<>"'']+$'));
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_language_check" CHECK ("language" IN ('en', 'sr'));
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_status_check" CHECK ("status" IN ('received'));
ALTER TABLE "submission_status_history" ADD CONSTRAINT "submission_status_history_status_check"
    CHECK ("status" IN ('received'));
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_position_check" CHECK ("position" >= 1);
ALTER TABLE "files" ADD CONSTRAINT "files_kind_check" CHECK ("kind" IN ('submission_file'));
ALTER TABLE "files" ADD CONSTRAINT "files_detected_type_check"
    CHECK ("detected_type" IN ('pdf', 'docx', 'doc', 'jpeg', 'png'));
ALTER TABLE "files" ADD CONSTRAINT "files_scan_state_check"
    CHECK ("scan_state" IN ('pending', 'clean', 'infected', 'not_clean'));
ALTER TABLE "files" ADD CONSTRAINT "files_scan_flag_check" CHECK ("scan_flag" IS NULL OR "scan_flag" IN ('macros'));
ALTER TABLE "files" ADD CONSTRAINT "files_storage_key_check"
    CHECK ("storage_key" ~ '^org/[0-9a-f-]{36}/[0-9a-f-]{36}$');
ALTER TABLE "files" ADD CONSTRAINT "files_size_check" CHECK ("size_bytes" >= 0);
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_held_reason_check"
    CHECK ("held_reason" IS NULL OR "held_reason" IN ('send_breaker_form', 'send_breaker_organisation', 'recipient_domain'));
ALTER TABLE "mail_templates" DROP CONSTRAINT "mail_templates_type_check";
ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_type_check" CHECK ("type" IN
    ('invitation', 'password_reset', 'email_change_confirmation', 'email_change_notice',
     'security_notice', 'sign_in_brake', 'test_message', 'submission_confirmation'));

-- Who released a held message (M3-BE-09). A file's form token has no foreign key: the token
-- is purged when it expires, and the files it attached stay.
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organisation_id_released_by_fkey"
    FOREIGN KEY ("organisation_id", "released_by") REFERENCES "users"("organisation_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The permissions of this milestone's modules (src/modules/access/permissions.ts).
INSERT INTO "role_permissions" ("role", "permission") VALUES
    ('admin', 'forms.read'),
    ('admin', 'forms.manage'),
    ('admin', 'submissions.read'),
    ('admin', 'held_mail.manage');

-- Row-level security of the tenant tables, as in the first migration.
ALTER TABLE "forms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forms" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "forms"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "form_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "form_versions"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "form_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "form_tokens"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "conference_deadlines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conference_deadlines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "conference_deadlines"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "conference_deadline_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conference_deadline_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "conference_deadline_changes"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "submissions"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "submission_authors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_authors" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "submission_authors"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "submission_status_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_status_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "submission_status_history"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "files"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Grants of the application role.
GRANT SELECT, INSERT, UPDATE ON "forms" TO confera_app;
-- A published version never changes (ADR-06): read and add, nothing else.
GRANT SELECT, INSERT ON "form_versions" TO confera_app;
-- Tokens are used up and purged when they expire (ADR-08, ADR-10).
GRANT SELECT, INSERT, UPDATE, DELETE ON "form_tokens" TO confera_app;
GRANT SELECT, INSERT, UPDATE ON "conference_deadlines" TO confera_app;
-- The history of a deadline only grows (FR-DL-03).
GRANT SELECT, INSERT ON "conference_deadline_changes" TO confera_app;
-- A submission is written once, in the transaction of the submit; the statuses of 0.4.0
-- change it through their own grant then. The counter of the references moves with it.
GRANT SELECT, INSERT ON "submissions" TO confera_app;
GRANT SELECT, INSERT ON "submission_authors" TO confera_app;
GRANT SELECT, INSERT ON "submission_status_history" TO confera_app;
-- Files: attached, scanned, and purged while unattached (ADR-10).
GRANT SELECT, INSERT, UPDATE, DELETE ON "files" TO confera_app;

-- The system role finds a form by its public key (ADR-05: "form by public key"): the three
-- columns of the answer and nothing of the form. The rest is read inside the organisation.
GRANT SELECT ("id", "organisation_id", "public_key") ON "forms" TO confera_system;
