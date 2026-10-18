-- Fixes of the 0.3.0 blank-slate run: every form version names who published it. The only
-- writer of versions is the publish of an admin (src/modules/forms/forms.service.ts), which
-- always sets it, and the contract promises it (FormVersionSummaryDto, FormVersionDto). A
-- version without a publisher came only from seed:e2e before this fix; a development
-- database that holds one is refused with a hint instead of a bare not-null error.

DO $$
BEGIN
  ALTER TABLE "form_versions" ALTER COLUMN "published_by" SET NOT NULL;
EXCEPTION WHEN not_null_violation THEN
  RAISE EXCEPTION 'form_versions holds a version without published_by (written by seed:e2e before 0.3.0 was fixed)'
    USING HINT = 'On a development database: corepack pnpm stack:wipe, then stack:up, db:provision, db:migrate and seed:e2e again.';
END
$$;
