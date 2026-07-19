SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE UNIQUE INDEX "site_version_id_workspace_site_key"
  ON "site_version"("id", "workspace_id", "site_id");

CREATE UNIQUE INDEX "site_publishable_claim_snapshot_id_workspace_site_key"
  ON "site_publishable_claim_snapshot"("id", "workspace_id", "site_id");

CREATE TABLE "site_copy_bundle" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "site_version_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "claim_snapshot_id" UUID NOT NULL,
  "task_attempt_id" UUID NOT NULL,
  "locale" TEXT NOT NULL,
  "source_locale" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "slot_catalog_version" TEXT NOT NULL,
  "input_hash" VARCHAR(64) NOT NULL,
  "bundle_digest" VARCHAR(64) NOT NULL,
  "document" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "site_copy_bundle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_copy_bundle_version_locale_key"
    UNIQUE ("site_version_id", "locale"),
  CONSTRAINT "site_copy_bundle_schema_check"
    CHECK ("schema_version" = 'site-builder-copy-bundle/v1'),
  CONSTRAINT "site_copy_bundle_slot_catalog_check"
    CHECK ("slot_catalog_version" = 'site-builder-copy-slots/v1'),
  CONSTRAINT "site_copy_bundle_status_check"
    CHECK ("status" IN ('complete', 'degraded')),
  CONSTRAINT "site_copy_bundle_locale_check"
    CHECK ("locale" ~ '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$'),
  CONSTRAINT "site_copy_bundle_source_locale_check"
    CHECK ("source_locale" ~ '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$'),
  CONSTRAINT "site_copy_bundle_input_hash_check"
    CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_copy_bundle_digest_check"
    CHECK ("bundle_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_copy_bundle_document_envelope_check"
    CHECK (
      "document"->>'schemaVersion' = "schema_version"
      AND "document"->>'slotCatalogVersion' = "slot_catalog_version"
      AND "document"->>'locale' = "locale"
      AND "document"->>'sourceLocale' = "source_locale"
      AND "document"->>'status' = "status"
      AND "document"->>'inputHash' = "input_hash"
      AND "document"->>'digest' = "bundle_digest"
      AND jsonb_typeof("document"->'slots') = 'object'
    )
);

CREATE INDEX "site_copy_bundle_workspace_site_locale_idx"
  ON "site_copy_bundle"("workspace_id", "site_id", "locale");
CREATE INDEX "site_copy_bundle_build_run_idx"
  ON "site_copy_bundle"("build_run_id");

ALTER TABLE "site_copy_bundle"
  ADD CONSTRAINT "site_copy_bundle_site_scope_fkey"
  FOREIGN KEY ("site_id", "workspace_id")
  REFERENCES "site"("id", "workspace_id")
  ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_copy_bundle_version_scope_fkey"
  FOREIGN KEY ("site_version_id", "workspace_id", "site_id")
  REFERENCES "site_version"("id", "workspace_id", "site_id")
  ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_copy_bundle_run_scope_fkey"
  FOREIGN KEY ("build_run_id", "workspace_id", "site_id")
  REFERENCES "site_build_run"("id", "workspace_id", "site_id")
  ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_copy_bundle_snapshot_scope_fkey"
  FOREIGN KEY ("claim_snapshot_id", "workspace_id", "site_id")
  REFERENCES "site_publishable_claim_snapshot"("id", "workspace_id", "site_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_copy_bundle_attempt_scope_fkey"
  FOREIGN KEY ("task_attempt_id", "workspace_id", "site_id")
  REFERENCES "site_build_task_attempt"("id", "workspace_id", "site_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE FUNCTION reject_site_copy_bundle_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CopyBundle rows are immutable';
END;
$$;

CREATE TRIGGER site_copy_bundle_immutable
  BEFORE UPDATE ON "site_copy_bundle"
  FOR EACH ROW EXECUTE FUNCTION reject_site_copy_bundle_update();

ALTER TABLE "site_copy_bundle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_copy_bundle" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_copy_bundle_tenant_isolation"
  ON "site_copy_bundle"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "site_copy_bundle" FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE "site_copy_bundle" FROM app_user;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_copy_bundle" FROM app_user;
GRANT SELECT, INSERT ON TABLE "site_copy_bundle" TO app_user;
