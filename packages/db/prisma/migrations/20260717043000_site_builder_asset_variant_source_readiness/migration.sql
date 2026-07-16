-- MF0-A forward-only source readiness guard. Earlier migrations have already
-- run in the shared Ubuntu development DB and remain byte-for-byte immutable.

CREATE FUNCTION enforce_asset_variant_source_ready()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."source_variant_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public."asset_variant" AS source
        WHERE source."id" = NEW."source_variant_id"
          AND source."status" = 'ready'
          AND source."content_hash" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'AssetVariant source must be ready and checksummed'
      USING ERRCODE = '23514',
            CONSTRAINT = 'asset_variant_source_ready_check';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_variant_source_ready
BEFORE INSERT OR UPDATE ON "asset_variant"
FOR EACH ROW
EXECUTE FUNCTION enforce_asset_variant_source_ready();
