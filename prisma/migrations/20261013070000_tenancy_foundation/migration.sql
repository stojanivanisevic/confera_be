-- Tenancy foundation (ADR-05, ADR-06): organisations, users and their roles, with
-- row-level security as the backstop of tenant isolation.
--
-- Runs as confera_owner, in a database prepared by `pnpm db:provision`.
-- The table and index statements are what `prisma migrate diff` generates from
-- schema.prisma; everything below "Hand-written" is not expressible in Prisma.

-- Case-insensitive text for email addresses. A trusted extension: the owner may create it.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateTable
CREATE TABLE "organisations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("organisation_id","user_id","role")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_organisation_id_id_key" ON "users"("organisation_id", "id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: composite on (organisation, id), so a role row cannot point at a user
-- of another organisation. A foreign-key check is not subject to row-level security.
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_organisation_id_user_id_fkey" FOREIGN KEY ("organisation_id", "user_id") REFERENCES "users"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written
-- ---------------------------------------------------------------------------

-- The two roles of the MVP (ADR-05). Permissions are code constants.
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_check" CHECK ("role" IN ('admin', 'reviewer'));

-- Row-level security.
--
-- The organisation of a transaction is the setting app.org_id, set with
-- set_config('app.org_id', <uuid>, true): local to the transaction, so a pooled
-- connection carries nothing over to its next user.
--
-- current_setting(..., true) is the missing-ok form: without the setting it gives NULL,
-- and after a transaction that set it, an empty string. NULLIF turns both into NULL, and
-- a comparison with NULL is never true: no organisation, no rows, and no write.
--
-- ENABLE alone would leave the table owner outside the policies; FORCE binds the owner
-- too. Only a role with the BYPASSRLS attribute is exempt (confera_system, and later the
-- backup role). A policy without TO applies to every role.
--
-- USING is the read check (which rows a statement may see, change or delete);
-- WITH CHECK is the write check (which rows an INSERT or UPDATE may leave behind).

ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organisations"
    FOR ALL
    USING ("id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "users"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "user_roles"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Grants. Nothing is granted by default: every table names what each run-time role may do.
--
-- confera_app, the running API. An organisation is created by the seed or by an
-- operator's command, never by the API, so there is no INSERT or DELETE on it.
GRANT SELECT, UPDATE ON "organisations" TO confera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO confera_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_roles" TO confera_app;

-- confera_system, the resolvers (ADR-05): it bypasses the policies, so it gets only the
-- columns a resolver returns or searches by. The user-by-email look-up of sign-in and of
-- a password-reset request returns ids only; the password hash is not granted, and is
-- read afterwards through the tenant client.
GRANT SELECT ("id", "organisation_id", "email") ON "users" TO confera_system;
