-- Access, organisation profile and audit (0.2.0, M2-BE-01 to M2-BE-06): users with a
-- state, the two roles and their permissions, sessions and known devices, secure links,
-- the mail outbox, the audit log and the security events of the instance.
--
-- Runs as confera_owner. The table and index statements are what `prisma migrate diff`
-- generates from schema.prisma, in an order that lets the seed of the roles come before
-- the foreign key that points at them; everything below "Hand-written" is not
-- expressible in Prisma.

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "address" TEXT,
ADD COLUMN     "contact_email" CITEXT,
ADD COLUMN     "eur_bank_name" TEXT,
ADD COLUMN     "eur_iban" TEXT,
ADD COLUMN     "eur_swift" TEXT,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "payment_details_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "payment_details_changed_by" UUID,
ADD COLUMN     "paypal_payee" CITEXT,
ADD COLUMN     "registration_number" TEXT,
ADD COLUMN     "rsd_account" TEXT,
ADD COLUMN     "tax_number" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "vat_note_en" TEXT,
ADD COLUMN     "vat_note_sr" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "second_factor_enrolled_at" TIMESTAMPTZ(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'invited',
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "roles" (
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role","permission")
);

-- Seed (hand-written, here so that the foreign key below finds the roles): the two roles
-- of the MVP and their permissions (ADR-05, FR-USR-01). The permissions are the code
-- constants of src/modules/access/permissions.ts; an integration test compares the two.
-- A reviewer's own permissions arrive with review (0.5.0).
INSERT INTO "roles" ("name", "description") VALUES
    ('admin', 'Does everything in the organisation.'),
    ('reviewer', 'Reviews the submissions assigned to them.');

INSERT INTO "role_permissions" ("role", "permission") VALUES
    ('admin', 'account.manage'),
    ('admin', 'audit.read'),
    ('admin', 'organisation.manage'),
    ('admin', 'organisation.read'),
    ('admin', 'users.manage'),
    ('admin', 'users.read'),
    ('reviewer', 'account.manage');

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "password_confirmed_at" TIMESTAMPTZ(3),
    "second_factor" TEXT NOT NULL DEFAULT 'not_required',
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "known_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "known_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secure_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "recipient" CITEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "secure_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "unique_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipient_user_id" UUID,
    "recipient_address" CITEXT NOT NULL,
    "link_purpose" TEXT,
    "link_user_id" UUID,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "changes" JSONB NOT NULL DEFAULT '{}',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "trace_id" UUID,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "client_address" TEXT NOT NULL,
    "user_organisation_id" UUID,
    "user_id" UUID,
    "known_device" BOOLEAN NOT NULL DEFAULT false,
    "summarised_at" TIMESTAMPTZ(3),

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_organisation_id_user_id_idx" ON "sessions"("organisation_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_organisation_id_id_key" ON "sessions"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "known_devices_organisation_id_id_key" ON "known_devices"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "known_devices_organisation_id_user_id_token_hash_key" ON "known_devices"("organisation_id", "user_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "secure_links_token_hash_key" ON "secure_links"("token_hash");

-- CreateIndex
CREATE INDEX "secure_links_organisation_id_user_id_purpose_idx" ON "secure_links"("organisation_id", "user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "secure_links_organisation_id_id_key" ON "secure_links"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "mail_outbox_organisation_id_recipient_user_id_kind_created__idx" ON "mail_outbox"("organisation_id", "recipient_user_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_outbox_organisation_id_id_key" ON "mail_outbox"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_outbox_organisation_id_unique_key_key" ON "mail_outbox"("organisation_id", "unique_key");

-- CreateIndex
CREATE INDEX "audit_entries_organisation_id_occurred_at_idx" ON "audit_entries"("organisation_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_entries_organisation_id_id_key" ON "audit_entries"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "security_events_occurred_at_idx" ON "security_events"("occurred_at");

-- CreateIndex
CREATE INDEX "security_events_user_id_occurred_at_idx" ON "security_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "security_events_client_address_occurred_at_idx" ON "security_events"("client_address", "occurred_at");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organisation_id_user_id_fkey" FOREIGN KEY ("organisation_id", "user_id") REFERENCES "users"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_organisation_id_user_id_fkey" FOREIGN KEY ("organisation_id", "user_id") REFERENCES "users"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secure_links" ADD CONSTRAINT "secure_links_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secure_links" ADD CONSTRAINT "secure_links_organisation_id_user_id_fkey" FOREIGN KEY ("organisation_id", "user_id") REFERENCES "users"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_organisation_id_actor_user_id_fkey" FOREIGN KEY ("organisation_id", "actor_user_id") REFERENCES "users"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written
-- ---------------------------------------------------------------------------

-- The roles are the rows of "roles" now; the list in a check of the first migration gives
-- way to the foreign key above.
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_role_check";

-- Closed sets of values.
ALTER TABLE "users" ADD CONSTRAINT "users_status_check"
    CHECK ("status" IN ('invited', 'active', 'deactivated', 'removed'));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_second_factor_check"
    CHECK ("second_factor" IN ('not_required', 'pending', 'passed'));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_end_reason_check"
    CHECK ("end_reason" IN ('signed_out', 'signed_out_everywhere', 'expired', 'signed_in_again',
        'password_changed', 'password_reset', 'email_changed', 'role_changed', 'deactivated',
        'removed', 'ended_by_admin', 'global_revoke', 'not_active'));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_ended_check"
    CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL));
ALTER TABLE "secure_links" ADD CONSTRAINT "secure_links_purpose_check"
    CHECK ("purpose" IN ('invitation', 'password_reset', 'email_change'));
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_status_check"
    CHECK ("status" IN ('queued'));
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_kind_check"
    CHECK ("kind" IN ('sign_in_failed', 'password_confirmation_failed'));

-- A token is never stored, only its SHA-256 (ADR-03, ADR-04): 64 hexadecimal digits.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "secure_links" ADD CONSTRAINT "secure_links_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- Row-level security of the tenant tables, as in the first migration.
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sessions"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "known_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "known_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "known_devices"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "secure_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secure_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "secure_links"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "mail_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "mail_outbox"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "audit_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_entries"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Reference tables: the same for every organisation, read by everyone, written only by the
-- owner role (in a migration). Forced, so that even the owner writes only through the
-- policy that names it.
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "reference_read" ON "roles" FOR SELECT USING (true);
CREATE POLICY "reference_write" ON "roles" FOR ALL TO confera_owner USING (true) WITH CHECK (true);

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "reference_read" ON "role_permissions" FOR SELECT USING (true);
CREATE POLICY "reference_write" ON "role_permissions" FOR ALL TO confera_owner USING (true) WITH CHECK (true);

-- The instance table: what happens before an organisation is known (a failed sign-in for
-- an unknown address). A statement sees and writes its rows only while NO organisation is
-- set, so code that works inside an organisation can never touch them.
ALTER TABLE "security_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "instance_only" ON "security_events"
    FOR ALL
    USING (NULLIF(current_setting('app.org_id', true), '') IS NULL)
    WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL);

-- Grants.
--
-- confera_app, the running API.
GRANT SELECT ON "roles" TO confera_app;
GRANT SELECT ON "role_permissions" TO confera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sessions" TO confera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "known_devices" TO confera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "secure_links" TO confera_app;
GRANT SELECT, INSERT, UPDATE ON "mail_outbox" TO confera_app;
-- The audit log can only grow (FR-AUD-02, ST-24): no UPDATE, no DELETE, no TRUNCATE.
GRANT SELECT, INSERT ON "audit_entries" TO confera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "security_events" TO confera_app;

-- confera_system, the resolvers (ADR-05): a session and a secure link by the hash of their
-- token, returning the two ids. Nothing else of either table.
GRANT SELECT ("id", "organisation_id", "token_hash") ON "sessions" TO confera_system;
GRANT SELECT ("id", "organisation_id", "token_hash") ON "secure_links" TO confera_system;
