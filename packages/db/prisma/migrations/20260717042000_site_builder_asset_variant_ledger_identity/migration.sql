-- MF0-A forward-only ledger identity hardening. 040000/041000 have already
-- run in the shared Ubuntu development DB and their bytes remain immutable.

CREATE OR REPLACE FUNCTION enforce_asset_variant_provenance_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'AssetVariant ledger identity is immutable after insert'
      USING ERRCODE = '23514',
            CONSTRAINT = 'asset_variant_ledger_identity_immutable';
  END IF;

  IF ROW(
    NEW."workspace_id",
    NEW."site_id",
    NEW."asset_id",
    NEW."variant_type",
    NEW."mime",
    NEW."width",
    NEW."height",
    NEW."duration_ms",
    NEW."bitrate_kbps",
    NEW."object_key",
    NEW."pipeline_version",
    NEW."recipe_hash",
    NEW."source_variant_id"
  ) IS DISTINCT FROM ROW(
    OLD."workspace_id",
    OLD."site_id",
    OLD."asset_id",
    OLD."variant_type",
    OLD."mime",
    OLD."width",
    OLD."height",
    OLD."duration_ms",
    OLD."bitrate_kbps",
    OLD."object_key",
    OLD."pipeline_version",
    OLD."recipe_hash",
    OLD."source_variant_id"
  ) THEN
    RAISE EXCEPTION 'AssetVariant provenance is immutable after insert'
      USING ERRCODE = '23514',
            CONSTRAINT = 'asset_variant_provenance_immutable';
  END IF;

  IF OLD."status" = 'ready' AND ROW(
    NEW."status", NEW."content_hash", NEW."size_bytes"
  ) IS DISTINCT FROM ROW(
    OLD."status", OLD."content_hash", OLD."size_bytes"
  ) THEN
    RAISE EXCEPTION 'ready AssetVariant materialization is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'asset_variant_ready_materialization_immutable';
  END IF;

  RETURN NEW;
END;
$$;
