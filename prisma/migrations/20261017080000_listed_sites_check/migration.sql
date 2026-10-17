-- 0.3.0, SEC-M2-12 (M2-ISS-21): the listed sites of a conference become the frame-ancestors
-- header of the frame page (ADR-07), so the column itself refuses what is not a canonical
-- origin, whoever writes it: at most 20 entries, each scheme, host and port only, in the
-- one form the API stores (src/modules/conferences/listed-sites.ts, CANONICAL_ORIGIN).
-- The rules of the stage (https only and no loopback host outside STAGE=local) are the
-- API's: the database does not know the stage. The frame list is checked once more when
-- it is read (frameSites).

CREATE FUNCTION listed_sites_are_origins(sites text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(cardinality(sites), 0) <= 20
     AND NOT EXISTS (
       SELECT 1 FROM unnest(sites) AS entry(site)
       WHERE site IS NULL OR site !~ '^https?://[a-z0-9.:\[\]-]+$'
     )
$$;

ALTER TABLE "conferences"
  ADD CONSTRAINT "conferences_listed_sites_are_origins"
  CHECK (listed_sites_are_origins("listed_sites"));
