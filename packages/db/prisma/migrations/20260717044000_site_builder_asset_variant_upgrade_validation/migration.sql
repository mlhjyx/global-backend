-- MF0-A forward-only upgrade validation. Fail closed instead of silently
-- blessing rows accepted before source readiness and exact extension binding.

DO $$
DECLARE
  invalid_source_rows bigint;
  invalid_object_key_rows bigint;
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
            CONSTRAINT = 'asset_variant_source_ready_upgrade_check',
            HINT = 'Quarantine or rebuild the affected derivatives before retrying this migration.';
  END IF;

  SELECT count(*)
    INTO invalid_object_key_rows
    FROM "asset_variant"
   WHERE "mime" NOT IN ('image/avif', 'image/webp', 'image/jpeg', 'image/png')
      OR "object_key" IS DISTINCT FROM (
        'ws/' || "workspace_id"::text || '/' || "site_id"::text ||
        '/variants/' || "asset_id"::text || '/' || "recipe_hash" ||
        CASE "mime"
          WHEN 'image/avif' THEN '.avif'
          WHEN 'image/webp' THEN '.webp'
          WHEN 'image/jpeg' THEN '.jpg'
          WHEN 'image/png' THEN '.png'
        END
      );

  IF invalid_object_key_rows > 0 THEN
    RAISE EXCEPTION
      'AssetVariant upgrade blocked: % row(s) have a non-canonical MIME/object-key extension',
      invalid_object_key_rows
      USING ERRCODE = '23514',
            CONSTRAINT = 'asset_variant_object_key_mime_upgrade_check',
            HINT = 'Move or quarantine the affected objects before retrying this migration.';
  END IF;
END;
$$;

ALTER TABLE "asset_variant"
  DROP CONSTRAINT "asset_variant_object_key_scope_check";
ALTER TABLE "asset_variant"
  ADD CONSTRAINT "asset_variant_object_key_scope_check"
  CHECK (
    "mime" IN ('image/avif', 'image/webp', 'image/jpeg', 'image/png')
    AND "object_key" = (
      'ws/' || "workspace_id"::text || '/' || "site_id"::text ||
      '/variants/' || "asset_id"::text || '/' || "recipe_hash" ||
      CASE "mime"
        WHEN 'image/avif' THEN '.avif'
        WHEN 'image/webp' THEN '.webp'
        WHEN 'image/jpeg' THEN '.jpg'
        WHEN 'image/png' THEN '.png'
      END
    )
  );
