-- MF0-A forward-only hardening after adversarial review. The preceding 040000
-- migration has already run in the shared Ubuntu development DB and is immutable.

-- A Variant object must never share the original Asset namespace. Binding the
-- path to asset_id + one-output recipe_hash also lets cleanup reconstruct and
-- verify the only legitimate key instead of trusting an arbitrary event value.
ALTER TABLE "asset_variant"
  DROP CONSTRAINT "asset_variant_object_key_scope_check";
ALTER TABLE "asset_variant"
  ADD CONSTRAINT "asset_variant_object_key_scope_check"
  CHECK (
    "object_key" LIKE (
      'ws/' || "workspace_id"::text || '/' || "site_id"::text ||
      '/variants/' || "asset_id"::text || '/' || "recipe_hash" || '.%'
    )
    AND substring(
      "object_key"
      FROM length(
        'ws/' || "workspace_id"::text || '/' || "site_id"::text ||
        '/variants/' || "asset_id"::text || '/' || "recipe_hash"
      ) + 1
    ) ~ '^\.[a-z0-9]+$'
  );

-- A publishable image that the compatibility projector cannot render is not a
-- valid ready row. Other future media classes retain nullable dimensions.
ALTER TABLE "asset_variant"
  ADD CONSTRAINT "asset_variant_ready_image_dimensions_check"
  CHECK (
    "status" <> 'ready'
    OR "mime" NOT LIKE 'image/%'
    OR (
      "width" IS NOT NULL AND "width" > 0
      AND "height" IS NOT NULL AND "height" > 0
    )
  );

-- Deleting/reparenting a source must not silently erase or rewrite descendant
-- object ledgers. Asset-level ON DELETE CASCADE remains the explicit aggregate
-- teardown path; individual Variant cleanup must run leaf-to-root after its
-- durable object plan exists.
ALTER TABLE "asset_variant"
  DROP CONSTRAINT "asset_variant_source_scope_fkey";
ALTER TABLE "asset_variant"
  ADD CONSTRAINT "asset_variant_source_scope_fkey"
  FOREIGN KEY ("source_variant_id", "workspace_id", "site_id", "asset_id")
  REFERENCES "asset_variant"("id", "workspace_id", "site_id", "asset_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION enforce_asset_variant_provenance_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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

CREATE TRIGGER asset_variant_provenance_immutable
BEFORE UPDATE ON "asset_variant"
FOR EACH ROW
EXECUTE FUNCTION enforce_asset_variant_provenance_immutable();
