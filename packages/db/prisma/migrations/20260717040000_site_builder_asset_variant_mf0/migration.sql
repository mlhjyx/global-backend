-- MF0-A: materialized media variants. This is intentionally additive:
-- Asset remains the logical original and derived_keys remains a temporary projection.

CREATE TABLE "asset_variant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "variant_type" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "bitrate_kbps" INTEGER,
    "size_bytes" INTEGER,
    "object_key" TEXT NOT NULL,
    "content_hash" TEXT,
    "pipeline_version" TEXT NOT NULL,
    "recipe_hash" TEXT NOT NULL,
    "source_variant_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_variant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "asset_variant_asset_id_recipe_hash_key" UNIQUE ("asset_id", "recipe_hash"),
    CONSTRAINT "asset_variant_object_key_key" UNIQUE ("object_key"),
    CONSTRAINT "asset_variant_id_workspace_site_asset_key" UNIQUE ("id", "workspace_id", "site_id", "asset_id"),
    CONSTRAINT "asset_variant_status_check"
      CHECK ("status" IN ('processing', 'ready', 'failed')),
    CONSTRAINT "asset_variant_variant_type_check"
      CHECK (length(btrim("variant_type")) > 0),
    CONSTRAINT "asset_variant_mime_check"
      CHECK ("mime" ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'),
    CONSTRAINT "asset_variant_pipeline_version_check"
      CHECK (length(btrim("pipeline_version")) > 0),
    CONSTRAINT "asset_variant_recipe_hash_check"
      CHECK ("recipe_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "asset_variant_content_hash_check"
      CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "asset_variant_width_check"
      CHECK ("width" IS NULL OR "width" > 0),
    CONSTRAINT "asset_variant_height_check"
      CHECK ("height" IS NULL OR "height" > 0),
    CONSTRAINT "asset_variant_duration_check"
      CHECK ("duration_ms" IS NULL OR "duration_ms" > 0),
    CONSTRAINT "asset_variant_bitrate_check"
      CHECK ("bitrate_kbps" IS NULL OR "bitrate_kbps" > 0),
    CONSTRAINT "asset_variant_size_bytes_check"
      CHECK ("size_bytes" IS NULL OR "size_bytes" > 0),
    CONSTRAINT "asset_variant_source_not_self_check"
      CHECK ("source_variant_id" IS NULL OR "source_variant_id" <> "id"),
    CONSTRAINT "asset_variant_state_payload_check"
      CHECK (
        ("status" = 'processing' AND "content_hash" IS NULL AND "size_bytes" IS NULL AND "error" IS NULL)
        OR
        ("status" = 'ready' AND "content_hash" IS NOT NULL AND "size_bytes" IS NOT NULL AND "error" IS NULL)
        OR
        ("status" = 'failed' AND length(btrim(COALESCE("error", ''))) > 0)
      ),
    CONSTRAINT "asset_variant_object_key_scope_check"
      CHECK (
        "object_key" LIKE ('ws/' || "workspace_id"::text || '/' || "site_id"::text || '/%')
        AND "object_key" NOT LIKE '%/uploads/%'
        AND "object_key" NOT LIKE '%/../%'
        AND "object_key" NOT LIKE '%//%'
      )
);

CREATE INDEX "asset_variant_workspace_site_asset_status_idx"
  ON "asset_variant"("workspace_id", "site_id", "asset_id", "status");
CREATE INDEX "asset_variant_source_variant_id_idx"
  ON "asset_variant"("source_variant_id");

ALTER TABLE "asset_variant"
  ADD CONSTRAINT "asset_variant_asset_scope_fkey"
  FOREIGN KEY ("asset_id", "workspace_id", "site_id")
  REFERENCES "asset"("id", "workspace_id", "site_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The source must be another variant of the exact same Asset scope. A plain
-- source_variant_id FK would permit cross-tenant or cross-asset provenance.
ALTER TABLE "asset_variant"
  ADD CONSTRAINT "asset_variant_source_scope_fkey"
  FOREIGN KEY ("source_variant_id", "workspace_id", "site_id", "asset_id")
  REFERENCES "asset_variant"("id", "workspace_id", "site_id", "asset_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_variant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_variant" FORCE ROW LEVEL SECURITY;
CREATE POLICY "asset_variant_tenant_isolation" ON "asset_variant"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- Explicit grant makes this migration independent of cluster-level default
-- privilege drift. app_user remains a non-superuser/non-BYPASSRLS runtime role.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "asset_variant" TO app_user;
