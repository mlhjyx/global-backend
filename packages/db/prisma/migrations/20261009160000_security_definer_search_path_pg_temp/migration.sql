-- SECURITY DEFINER routines run with their owner's rights. When a routine's search_path
-- does not list pg_temp, PostgreSQL searches pg_temp FIRST for tables, so any session that
-- may create temporary tables can shadow a table the routine reads unqualified and make it
-- act on forged rows. app_user may: the database grants TEMPORARY to PUBLIC. 126 routines
-- written before September carry `search_path = pg_catalog, public`; later ones already list
-- pg_temp last. This lists pg_temp last for every remaining one, as the PostgreSQL manual
-- prescribes ("Writing SECURITY DEFINER Functions Safely").
--
-- Only the search_path setting changes. Bodies, owners, volatility, security and grants stay
-- exactly as they are. A routine with any other search_path is not rewritten: it fails the
-- final check and the whole migration rolls back. Forward-only; no data is touched.
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
    WHERE p.prosecdef
      AND n.nspname <> 'information_schema'
      AND n.nspname NOT LIKE 'pg\_%'
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
  WHERE p.prosecdef
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\_%'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p.proconfig) AS setting
      WHERE setting LIKE 'search\_path=%' AND setting LIKE '%, pg\_temp');
  IF unhardened IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY_DEFINER_SEARCH_PATH_UNHARDENED: %', unhardened
      USING ERRCODE = 'P0001';
  END IF;
END
$harden$;

COMMIT;
