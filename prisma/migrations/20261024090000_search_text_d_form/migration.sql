-- 0.4.0, fix round (Q4-01): "dordevic" finds "Đorđević". A text with đ is indexed in two
-- forms, đ as dj and đ as d, as src/modules/submissions/search.ts (`searchTextOf`) writes it
-- with every submit and correction: each part with đ follows with its second form. This
-- rewrites the rows that hold a đ (or ђ) with the same folding as migration
-- 20261019090000_submission_statuses_and_search; the other rows are already right.

CREATE FUNCTION pg_temp.confera_fold(value TEXT, dj TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fold$
  SELECT btrim(regexp_replace(
    translate(
      replace(replace(replace(replace(replace(replace(replace(lower(value),
        'đ', dj), 'ђ', dj), 'љ', 'lj'), 'њ', 'nj'), 'џ', 'dz'), 'ж', 'z'), 'ш', 's'),
      'šžčćàáâäãåèéêëìíîïòóôöõùúûüýÿñабвгдезијклмнопрстћуфхцч',
      'szccaaaaaaeeeeiiiiooooouuuuyynabvgdezijklmnoprstcufhcc'),
    '[^a-z0-9@.-]+', ' ', 'g'))
$fold$;

-- One part, followed by its second form when it differs.
CREATE FUNCTION pg_temp.confera_part(value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $part$
  SELECT pg_temp.confera_fold(value, 'dj') ||
    CASE WHEN pg_temp.confera_fold(value, 'd') = pg_temp.confera_fold(value, 'dj') THEN ''
         ELSE ' | ' || pg_temp.confera_fold(value, 'd') END
$part$;

-- Row-level security is forced on the owner too: lifted for this transaction only.
ALTER TABLE "submissions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "submission_authors" NO FORCE ROW LEVEL SECURITY;

UPDATE "submissions" AS s SET "search_text" =
  pg_temp.confera_part(s."reference") || ' | ' || pg_temp.confera_part(coalesce(s."title", '')) || coalesce((
    SELECT string_agg(
      ' | ' || pg_temp.confera_part(a."first_name" || ' ' || a."last_name" || ' ' || a."email" || ' ' || coalesce(a."institution", '')),
      '' ORDER BY a."position")
    FROM "submission_authors" a
    WHERE a."organisation_id" = s."organisation_id" AND a."submission_id" = s."id"), '')
WHERE lower(coalesce(s."title", '')) ~ '[đђ]'
   OR EXISTS (
     SELECT 1 FROM "submission_authors" a
     WHERE a."organisation_id" = s."organisation_id" AND a."submission_id" = s."id"
       AND lower(a."first_name" || ' ' || a."last_name" || ' ' || coalesce(a."institution", '')) ~ '[đђ]');

ALTER TABLE "submissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "submission_authors" FORCE ROW LEVEL SECURITY;
