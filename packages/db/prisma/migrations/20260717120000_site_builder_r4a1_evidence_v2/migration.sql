-- R4-A1 Evidence 2.0 is an additive, forward-only expand migration.
-- Rollback is operational: deploy the v1 reader/writer, then apply a new forward
-- migration that removes these unused tables only after proving no v2 rows exist.
-- Existing BrandProfile rows remain evidence_schema_version=1; no provenance is fabricated.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

LOCK TABLE "site" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile" IN SHARE ROW EXCLUSIVE MODE;

-- Fail closed before replacing the historical id-only FK. A migration role that
-- cannot bypass FORCE RLS also fails here instead of validating an incomplete view.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "brand_profile" bp
    LEFT JOIN "site" s ON s."id" = bp."site_id"
    WHERE s."id" IS NULL OR bp."workspace_id" <> s."workspace_id"
  ) THEN
    RAISE EXCEPTION 'R4-A1 preflight failed: brand_profile/site tenant provenance mismatch';
  END IF;
END
$$;

ALTER TABLE "brand_profile"
  ADD COLUMN "evidence_schema_version" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "brand_profile_evidence_schema_version_check"
    CHECK ("evidence_schema_version" IN (1, 2));

CREATE UNIQUE INDEX "brand_profile_id_workspace_site_key"
  ON "brand_profile"("id", "workspace_id", "site_id");

ALTER TABLE "brand_profile"
  DROP CONSTRAINT "brand_profile_site_id_fkey",
  ADD CONSTRAINT "brand_profile_site_workspace_fkey"
    FOREIGN KEY ("site_id", "workspace_id")
    REFERENCES "site"("id", "workspace_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "site_evidence_source_snapshot" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "source_key" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_role" TEXT NOT NULL,
  "hash_algorithm" TEXT NOT NULL DEFAULT 'sha256',
  "content_hash" TEXT NOT NULL,
  "upstream_content_hash" TEXT,
  "normalization_version" TEXT NOT NULL,
  "snapshot_text" TEXT NOT NULL,
  "display_url" TEXT,
  "fetched_at" TIMESTAMP(3),
  "provenance" JSONB NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "site_evidence_source_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_evidence_source_snapshot_source_key_check"
    CHECK (char_length("source_key") BETWEEN 1 AND 1024),
  CONSTRAINT "site_evidence_source_snapshot_source_type_check"
    CHECK ("source_type" IN ('intake', 'upload', 'storefront', 'web_research')),
  CONSTRAINT "site_evidence_source_snapshot_source_role_check"
    CHECK ("source_role" IN ('fact_candidate', 'research_hint')),
  CONSTRAINT "site_evidence_source_snapshot_hash_algorithm_check"
    CHECK ("hash_algorithm" = 'sha256'),
  CONSTRAINT "site_evidence_source_snapshot_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_evidence_source_snapshot_upstream_content_hash_check"
    CHECK ("upstream_content_hash" IS NULL OR "upstream_content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_evidence_source_snapshot_normalization_version_check"
    CHECK ("normalization_version" = 'evidence-text/1'),
  CONSTRAINT "site_evidence_source_snapshot_text_check"
    CHECK (char_length("snapshot_text") BETWEEN 1 AND 20000),
  CONSTRAINT "site_evidence_source_snapshot_display_url_check"
    CHECK (
      "display_url" IS NULL OR (
        char_length("display_url") <= 2048
        AND "display_url" ~ '^https?://'
        AND position('#' IN "display_url") = 0
        AND "display_url" !~ '^https?://[^/]*@'
      )
    ),
  CONSTRAINT "site_evidence_source_snapshot_provenance_check"
    CHECK (jsonb_typeof("provenance") = 'object'),
  CONSTRAINT "site_evidence_source_snapshot_dedupe_key_check"
    CHECK ("dedupe_key" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "site_evidence_source_snapshot_site_dedupe_key"
  ON "site_evidence_source_snapshot"("site_id", "dedupe_key");
CREATE UNIQUE INDEX "site_evidence_source_snapshot_scope_hash_key"
  ON "site_evidence_source_snapshot"("id", "workspace_id", "site_id", "content_hash");
CREATE INDEX "site_evidence_source_snapshot_workspace_site_type_idx"
  ON "site_evidence_source_snapshot"("workspace_id", "site_id", "source_type");

ALTER TABLE "site_evidence_source_snapshot"
  ADD CONSTRAINT "site_evidence_source_snapshot_site_scope_fkey"
    FOREIGN KEY ("site_id", "workspace_id")
    REFERENCES "site"("id", "workspace_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "brand_profile_evidence_ref" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "brand_profile_id" UUID NOT NULL,
  "fact_index" INTEGER NOT NULL,
  "fact_key" TEXT NOT NULL,
  "source_snapshot_id" UUID NOT NULL,
  "source_content_hash" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "quote_start" INTEGER NOT NULL,
  "quote_end" INTEGER NOT NULL,
  "quote_prefix" TEXT,
  "quote_suffix" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "brand_profile_evidence_ref_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brand_profile_evidence_ref_fact_index_check"
    CHECK ("fact_index" >= 0),
  CONSTRAINT "brand_profile_evidence_ref_fact_key_check"
    CHECK (char_length("fact_key") BETWEEN 1 AND 120),
  CONSTRAINT "brand_profile_evidence_ref_source_hash_check"
    CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "brand_profile_evidence_ref_quote_check"
    CHECK (char_length("quote") BETWEEN 8 AND 512),
  CONSTRAINT "brand_profile_evidence_ref_quote_position_check"
    CHECK (
      "quote_start" >= 0
      AND "quote_end" > "quote_start"
      AND "quote_end" - "quote_start" = char_length("quote")
    ),
  CONSTRAINT "brand_profile_evidence_ref_quote_context_check"
    CHECK (
      ("quote_prefix" IS NULL OR char_length("quote_prefix") <= 32)
      AND ("quote_suffix" IS NULL OR char_length("quote_suffix") <= 32)
    )
);

CREATE UNIQUE INDEX "brand_profile_evidence_ref_profile_fact_key"
  ON "brand_profile_evidence_ref"("brand_profile_id", "fact_index");
CREATE INDEX "brand_profile_evidence_ref_workspace_site_source_idx"
  ON "brand_profile_evidence_ref"("workspace_id", "site_id", "source_snapshot_id");

ALTER TABLE "brand_profile_evidence_ref"
  ADD CONSTRAINT "brand_profile_evidence_ref_profile_scope_fkey"
    FOREIGN KEY ("brand_profile_id", "workspace_id", "site_id")
    REFERENCES "brand_profile"("id", "workspace_id", "site_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "brand_profile_evidence_ref_source_scope_hash_fkey"
    FOREIGN KEY ("source_snapshot_id", "workspace_id", "site_id", "source_content_hash")
    REFERENCES "site_evidence_source_snapshot"("id", "workspace_id", "site_id", "content_hash")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Application writes are append-only. Owner-level cascade deletion remains available
-- for Site retention/deletion; direct provenance updates are rejected for every role.
CREATE FUNCTION reject_site_evidence_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Evidence 2.0 provenance is immutable after insert';
END
$$;

CREATE TRIGGER site_evidence_source_snapshot_immutable
  BEFORE UPDATE ON "site_evidence_source_snapshot"
  FOR EACH ROW EXECUTE FUNCTION reject_site_evidence_update();

CREATE TRIGGER brand_profile_evidence_ref_immutable
  BEFORE UPDATE ON "brand_profile_evidence_ref"
  FOR EACH ROW EXECUTE FUNCTION reject_site_evidence_update();

ALTER TABLE "site_evidence_source_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_evidence_source_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_evidence_source_snapshot_tenant_isolation"
  ON "site_evidence_source_snapshot"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "brand_profile_evidence_ref" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_profile_evidence_ref" FORCE ROW LEVEL SECURITY;
CREATE POLICY "brand_profile_evidence_ref_tenant_isolation"
  ON "brand_profile_evidence_ref"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "site_evidence_source_snapshot" FROM PUBLIC;
REVOKE ALL ON TABLE "brand_profile_evidence_ref" FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE "site_evidence_source_snapshot" TO app_user;
GRANT SELECT, INSERT ON TABLE "brand_profile_evidence_ref" TO app_user;
