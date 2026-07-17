-- Re-run the historical source scan with row filtering explicitly disabled.
-- With FORCE RLS, a migration role that cannot bypass policies must fail here
-- instead of seeing zero rows and reporting a false clean result.

BEGIN;
SET LOCAL row_security = off;
LOCK TABLE "asset_variant" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  invalid_source_rows bigint;
BEGIN
  SELECT count(*)
    INTO invalid_source_rows
    FROM "asset_variant" AS child
    JOIN "asset_variant" AS source
      ON source."id" = child."source_variant_id"
     AND source."workspace_id" = child."workspace_id"
     AND source."site_id" = child."site_id"
     AND source."asset_id" = child."asset_id"
   WHERE child."source_variant_id" IS NOT NULL
     AND (
       source."status" IS DISTINCT FROM 'ready'
       OR source."content_hash" IS NULL
     );

  IF invalid_source_rows > 0 THEN
    RAISE EXCEPTION
      'AssetVariant upgrade blocked: % derived row(s) reference a non-ready or checksum-less source',
      invalid_source_rows
      USING ERRCODE = '23514',
            CONSTRAINT = 'asset_variant_source_ready_rls_safe_upgrade_check',
            HINT = 'Quarantine or rebuild the affected derivatives before retrying this migration.';
  END IF;
END;
$$;

COMMIT;
