-- When a routine's search_path does not list pg_temp, PostgreSQL searches pg_temp FIRST for
-- tables while the routine runs, so a session that may create temporary tables can shadow a
-- table the routine reads unqualified. app_user may: the database grants TEMPORARY to PUBLIC.
-- That matters wherever the routine runs with more rights than the session:
-- * 126 SECURITY DEFINER routines carry `search_path = pg_catalog, public` and run as their
--   owner;
-- * 83 SECURITY INVOKER routines (21 of them trigger functions) carry the same setting. A
--   routine's own setting replaces its caller's, and inside a SECURITY DEFINER routine, or in
--   a trigger fired by one, an invoker routine runs as that routine's owner.
-- 42 routines already list pg_temp last. This lists pg_temp last for every remaining routine
-- that sets `pg_catalog, public`, as the PostgreSQL manual prescribes ("Writing SECURITY
-- DEFINER Functions Safely"). Routines without a search_path setting keep their caller's,
-- which inside a hardened SECURITY DEFINER routine now ends in pg_temp.
--
-- Only the search_path setting changes. Bodies, owners, volatility, security and grants stay
-- exactly as they are. A routine with any other search_path is not rewritten: the final check
-- fails and the whole migration rolls back. The same check requires every SECURITY DEFINER
-- routine to set a search_path. Forward-only; no data is touched.
-- apps/api/src/prisma/security-definer-search-path*.spec.ts keep later migrations in line.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $harden$
DECLARE
  routine regprocedure;
  routine_kind "char";
  unhardened text;
BEGIN
  FOR routine, routine_kind IN
    SELECT p.oid::regprocedure, p.prokind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE left(n.nspname, 3) <> 'pg_'
      AND n.nspname <> 'information_schema'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
    ORDER BY p.oid::regprocedure::text
  LOOP
    EXECUTE format(
      'ALTER %s %s SET search_path = pg_catalog, public, pg_temp',
      CASE routine_kind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
      routine);
  END LOOP;

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
  INTO unhardened
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE left(n.nspname, 3) <> 'pg_'
    AND n.nspname <> 'information_schema'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND (
      -- a search_path setting that does not end in pg_temp
      EXISTS (
        SELECT 1 FROM unnest(p.proconfig) AS setting
        WHERE left(setting, 12) = 'search_path='
          AND right(setting, 9) <> ', pg_temp')
      -- a SECURITY DEFINER routine that runs on its caller's search_path
      OR (p.prosecdef AND NOT EXISTS (
        SELECT 1 FROM unnest(p.proconfig) AS setting
        WHERE left(setting, 12) = 'search_path=')));
  IF unhardened IS NOT NULL THEN
    RAISE EXCEPTION 'ROUTINE_SEARCH_PATH_UNHARDENED: %', unhardened
      USING ERRCODE = 'P0001';
  END IF;
END
$harden$;

COMMIT;
