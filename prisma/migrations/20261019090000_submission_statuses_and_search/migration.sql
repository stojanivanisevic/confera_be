-- 0.4.0, part 2: the status model of Spec section 5 (M4-BE-01), notes, edits with kept
-- revisions, the status emails rendered when they are queued (M4-BE-02, M2-ISS-05), the
-- switch of the status emails per conference (FR-MAIL-07), and the search of the
-- submissions table without diacritics (M4-BE-04, FR-SUB-03, NFR-PERF-02).

-- A trusted extension: the owner may create it. Trigram indexes serve `LIKE '%term%'`.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The statuses (Spec section 5). The 0.3.0 status `received` is `new`.
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_status_check";
ALTER TABLE "submission_status_history" DROP CONSTRAINT "submission_status_history_status_check";
-- Row-level security is forced on the owner too: the rows of every organisation are
-- rewritten here with it lifted for this transaction only, and forced again below.
ALTER TABLE "submissions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "submission_status_history" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "submission_authors" NO FORCE ROW LEVEL SECURITY;
UPDATE "submissions" SET "status" = 'new' WHERE "status" = 'received';
UPDATE "submission_status_history" SET "status" = 'new' WHERE "status" = 'received';
ALTER TABLE "submissions" ALTER COLUMN "status" SET DEFAULT 'new';
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_status_check"
    CHECK ("status" IN ('new', 'open', 'returned_for_revision', 'accepted', 'rejected', 'withdrawn'));
ALTER TABLE "submission_status_history" ADD CONSTRAINT "submission_status_history_status_check"
    CHECK ("status" IN ('new', 'open', 'returned_for_revision', 'accepted', 'rejected', 'withdrawn'));

-- A submission changes now: its status, and its data when an admin corrects it for the
-- author (FR-SUB-06). Raised by every change; a change that names an older version is
-- refused (two admins at once, a double click).
ALTER TABLE "submissions" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "search_text" TEXT NOT NULL DEFAULT '';
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_version_check" CHECK ("version" >= 1);

-- The search text (M4-BE-04): reference, title, and every author's names, email and
-- institution, folded as src/modules/submissions/search.ts folds a query (lower case, no
-- diacritics, đ as dj, Serbian Cyrillic in Latin letters). The application writes it with
-- every submit and edit; this fills the rows of 0.3.0 with the same folding of the
-- letters that occur in them.
CREATE FUNCTION pg_temp.confera_fold(value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fold$
  SELECT regexp_replace(
    translate(
      replace(replace(replace(replace(replace(replace(replace(lower(value),
        'đ', 'dj'), 'ђ', 'dj'), 'љ', 'lj'), 'њ', 'nj'), 'џ', 'dz'), 'ж', 'z'), 'ш', 's'),
      'šžčćàáâäãåèéêëìíîïòóôöõùúûüýÿñабвгдезијклмнопрстћуфхцч',
      'szccaaaaaaeeeeiiiiooooouuuuyynabvgdezijklmnoprstcufhcc'),
    '[^a-z0-9@.-]+', ' ', 'g')
$fold$;
UPDATE "submissions" AS s SET "search_text" =
  pg_temp.confera_fold(s."reference") || ' | ' || pg_temp.confera_fold(coalesce(s."title", '')) || coalesce((
    SELECT string_agg(
      ' | ' || pg_temp.confera_fold(a."first_name" || ' ' || a."last_name" || ' ' || a."email" || ' ' || coalesce(a."institution", '')),
      '' ORDER BY a."position")
    FROM "submission_authors" a
    WHERE a."organisation_id" = s."organisation_id" AND a."submission_id" = s."id"), '');

ALTER TABLE "submissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "submission_status_history" FORCE ROW LEVEL SECURITY;
ALTER TABLE "submission_authors" FORCE ROW LEVEL SECURITY;

CREATE INDEX "submissions_search_text_idx" ON "submissions" USING GIN ("search_text" gin_trgm_ops);
CREATE INDEX "submissions_organisation_id_status_received_at_idx"
    ON "submissions"("organisation_id", "status", "received_at");

-- The history of the statuses: which transition of the state table, from what, the
-- internal reason (withdraw, reopen; never sent), the text for the author, and what became
-- of the email: queued (its outbox row), template_off (FR-MAIL-07) or none.
ALTER TABLE "submission_status_history" ADD COLUMN "from_status" TEXT,
ADD COLUMN "transition" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "reason" TEXT,
ADD COLUMN "message" TEXT,
ADD COLUMN "mail_state" TEXT NOT NULL DEFAULT 'queued',
ADD COLUMN "message_id" UUID;
ALTER TABLE "submission_status_history" ALTER COLUMN "transition" DROP DEFAULT;
ALTER TABLE "submission_status_history" ALTER COLUMN "mail_state" DROP DEFAULT;
ALTER TABLE "submission_status_history" ADD CONSTRAINT "submission_status_history_transition_check"
    CHECK ("transition" IN (1, 2, 4, 5, 6, 7, 8, 9));
ALTER TABLE "submission_status_history" ADD CONSTRAINT "submission_status_history_mail_state_check"
    CHECK ("mail_state" IN ('queued', 'template_off', 'none'));
ALTER TABLE "submission_status_history" ADD CONSTRAINT "submission_status_history_texts_check"
    CHECK (("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 2000)
       AND ("message" IS NULL OR char_length("message") BETWEEN 1 AND 5000));

-- The template types of the status emails (FR-MAIL-03): transitions 2 and 4 to 9.
ALTER TABLE "mail_templates" DROP CONSTRAINT "mail_templates_type_check";
ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_type_check" CHECK ("type" IN
    ('invitation', 'password_reset', 'email_change_confirmation', 'email_change_notice',
     'security_notice', 'sign_in_brake', 'test_message', 'submission_confirmation',
     'submission_opened', 'submission_returned', 'submission_resumed', 'submission_accepted',
     'submission_rejected', 'submission_withdrawn', 'submission_reopened'));

-- Status emails off per conference (FR-MAIL-07): the template types switched off. All on by default.
ALTER TABLE "conferences" ADD COLUMN "status_mail_off" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_status_mail_off_check"
    CHECK ("status_mail_off" <@ ARRAY['submission_opened', 'submission_returned', 'submission_resumed',
      'submission_accepted', 'submission_rejected', 'submission_withdrawn', 'submission_reopened']::TEXT[]);

-- The outbox renders a message when it is queued (ADR-13, M2-ISS-05): what an admin was
-- shown is what is sent. The secure link is a mark in the stored text, replaced by a
-- fresh link at send time and by [link] in the log; the images are their file ids.
ALTER TABLE "mail_outbox" ADD COLUMN "rendered_subject" TEXT,
ADD COLUMN "rendered_html" TEXT,
ADD COLUMN "rendered_text" TEXT,
ADD COLUMN "template_server_id" UUID,
ADD COLUMN "image_ids" UUID[] NOT NULL DEFAULT '{}';
-- The mail log keeps the body and the ids of its images, not their bytes (ADR-13).
ALTER TABLE "mail_log" ADD COLUMN "image_ids" UUID[] NOT NULL DEFAULT '{}';

ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_rendered_check"
    CHECK (("rendered_subject" IS NULL) = ("rendered_html" IS NULL)
       AND ("rendered_subject" IS NULL) = ("rendered_text" IS NULL));

-- Notes of the admins on a submission (FR-SUB-07): never shown to authors or reviewers.
CREATE TABLE "submission_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_notes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "submission_notes_organisation_id_id_key" ON "submission_notes"("organisation_id", "id");
CREATE INDEX "submission_notes_organisation_id_submission_id_created_at_idx"
    ON "submission_notes"("organisation_id", "submission_id", "created_at");
ALTER TABLE "submission_notes" ADD CONSTRAINT "submission_notes_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_notes" ADD CONSTRAINT "submission_notes_organisation_id_submission_id_fkey"
    FOREIGN KEY ("organisation_id", "submission_id") REFERENCES "submissions"("organisation_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "submission_notes" ADD CONSTRAINT "submission_notes_organisation_id_author_user_id_fkey"
    FOREIGN KEY ("organisation_id", "author_user_id") REFERENCES "users"("organisation_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_notes" ADD CONSTRAINT "submission_notes_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 5000);

-- The kept revisions of a submission (FR-SUB-06): every correction by an admin, with the
-- answers before and after, who and when. The first one's `before` is the original.
CREATE TABLE "submission_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" UUID NOT NULL,
    "fields" TEXT[] NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,

    CONSTRAINT "submission_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "submission_revisions_organisation_id_id_key" ON "submission_revisions"("organisation_id", "id");
CREATE UNIQUE INDEX "submission_revisions_organisation_id_submission_id_number_key"
    ON "submission_revisions"("organisation_id", "submission_id", "number");
ALTER TABLE "submission_revisions" ADD CONSTRAINT "submission_revisions_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_revisions" ADD CONSTRAINT "submission_revisions_organisation_id_submission_id_fkey"
    FOREIGN KEY ("organisation_id", "submission_id") REFERENCES "submissions"("organisation_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "submission_revisions" ADD CONSTRAINT "submission_revisions_organisation_id_changed_by_fkey"
    FOREIGN KEY ("organisation_id", "changed_by") REFERENCES "users"("organisation_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_revisions" ADD CONSTRAINT "submission_revisions_number_check" CHECK ("number" >= 1);

ALTER TABLE "submission_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "submission_notes"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE "submission_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "submission_revisions"
    FOR ALL
    USING ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK ("organisation_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Grants of the application role, as small as the work needs.
-- A submission changes its status and the data an admin corrects; nothing else of it.
GRANT UPDATE ("status", "version", "updated_at", "answers", "title", "participation_type",
  "first_author_name", "first_author_institution", "corresponding_email", "corresponding_domain",
  "author_count", "search_text") ON "submissions" TO confera_app;
-- A correction replaces the list of authors.
GRANT DELETE ON "submission_authors" TO confera_app;
-- Notes and revisions only grow.
GRANT SELECT, INSERT ON "submission_notes" TO confera_app;
GRANT SELECT, INSERT ON "submission_revisions" TO confera_app;

-- The permissions of 0.4.0 (src/modules/access/permissions.ts): change submissions
-- (statuses, notes, corrections), edit the email templates, resend from the mail log and
-- set its retention. Admins only.
INSERT INTO "role_permissions" ("role", "permission") VALUES
  ('admin', 'submissions.manage'),
  ('admin', 'templates.manage'),
  ('admin', 'mail_log.manage');
