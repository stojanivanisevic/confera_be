-- One default and one fallback mail server per organisation (ADR-11, FR-SMTP-02; E2-09).
-- The service marks a server under a lock of the organisation; these indexes hold the rule
-- even for writers that forget it. Partial indexes are not expressible in schema.prisma:
-- `db:diff` lists them as to be dropped; keep them.
CREATE UNIQUE INDEX "mail_servers_one_default" ON "mail_servers" ("organisation_id") WHERE "is_default";
CREATE UNIQUE INDEX "mail_servers_one_fallback" ON "mail_servers" ("organisation_id") WHERE "is_fallback";
