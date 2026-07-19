SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE UNIQUE INDEX "brand_profile_claim_bridge_id_workspace_site_key"
  ON "brand_profile_claim_bridge"("id", "workspace_id", "site_id");

CREATE TABLE "site_publishable_claim_snapshot" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "company_profile_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL,
  "captured_at" TIMESTAMP(3) NOT NULL,
  "snapshot_digest" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "site_publishable_claim_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_publishable_claim_snapshot_schema_check"
    CHECK ("schema_version" = 'site-builder-publishable-claim-snapshot/v1'),
  CONSTRAINT "site_publishable_claim_snapshot_digest_check"
    CHECK ("snapshot_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_publishable_claim_snapshot_build_run_key" UNIQUE ("build_run_id"),
  CONSTRAINT "site_publishable_claim_snapshot_run_scope_key"
    UNIQUE ("build_run_id", "workspace_id", "site_id"),
  CONSTRAINT "site_publishable_claim_snapshot_scope_key"
    UNIQUE ("id", "workspace_id", "site_id", "company_profile_id")
);

CREATE INDEX "site_publishable_claim_snapshot_workspace_site_captured_idx"
  ON "site_publishable_claim_snapshot"("workspace_id", "site_id", "captured_at");

ALTER TABLE "site_publishable_claim_snapshot"
  ADD CONSTRAINT "site_publishable_claim_snapshot_run_scope_fkey"
  FOREIGN KEY ("build_run_id", "workspace_id", "site_id")
  REFERENCES "site_build_run"("id", "workspace_id", "site_id")
  ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_site_scope_fkey"
  FOREIGN KEY ("site_id", "workspace_id", "company_profile_id")
  REFERENCES "site"("id", "workspace_id", "company_profile_id")
  ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_company_scope_fkey"
  FOREIGN KEY ("company_profile_id", "workspace_id")
  REFERENCES "company_profile"("id", "workspace_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "site_publishable_claim_snapshot_item" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "company_profile_id" UUID NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "claim_id" UUID NOT NULL,
  "claim_version" INTEGER NOT NULL,
  "fact_key" TEXT NOT NULL,
  "claim_type" TEXT NOT NULL,
  "statement" TEXT NOT NULL,
  "valid_until" TIMESTAMP(3),
  "approved_by" TEXT NOT NULL,
  "approved_at" TIMESTAMP(3) NOT NULL,
  "bridge_id" UUID NOT NULL,
  "brand_profile_id" UUID NOT NULL,
  "evidence_ref_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "source_snapshot_id" UUID NOT NULL,
  "source_content_hash" VARCHAR(64) NOT NULL,
  "quote" TEXT NOT NULL,
  "quote_start" INTEGER NOT NULL,
  "quote_end" INTEGER NOT NULL,
  "quote_prefix" TEXT,
  "quote_suffix" TEXT,
  "cert_asset_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "site_publishable_claim_snapshot_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_publishable_claim_snapshot_item_claim_version_check"
    CHECK ("claim_version" >= 1),
  CONSTRAINT "site_publishable_claim_snapshot_item_ordinal_check"
    CHECK ("ordinal" >= 0),
  CONSTRAINT "site_publishable_claim_snapshot_item_fact_key_check"
    CHECK ("fact_key" ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'),
  CONSTRAINT "site_publishable_claim_snapshot_item_source_hash_check"
    CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_publishable_claim_snapshot_item_quote_selector_check"
    CHECK ("quote_start" >= 0 AND "quote_end" > "quote_start"),
  CONSTRAINT "site_publishable_claim_snapshot_item_claim_key"
    UNIQUE ("snapshot_id", "claim_id"),
  CONSTRAINT "site_publishable_claim_snapshot_item_ordinal_key"
    UNIQUE ("snapshot_id", "ordinal")
);

CREATE INDEX "site_publishable_claim_snapshot_item_workspace_site_claim_idx"
  ON "site_publishable_claim_snapshot_item"("workspace_id", "site_id", "claim_id");

ALTER TABLE "site_publishable_claim_snapshot_item"
  ADD CONSTRAINT "site_publishable_claim_snapshot_item_snapshot_scope_fkey"
  FOREIGN KEY ("snapshot_id", "workspace_id", "site_id", "company_profile_id")
  REFERENCES "site_publishable_claim_snapshot"("id", "workspace_id", "site_id", "company_profile_id")
  ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_item_claim_scope_fkey"
  FOREIGN KEY ("claim_id", "workspace_id", "company_profile_id")
  REFERENCES "claim"("id", "workspace_id", "company_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_item_bridge_scope_fkey"
  FOREIGN KEY ("bridge_id", "workspace_id", "site_id")
  REFERENCES "brand_profile_claim_bridge"("id", "workspace_id", "site_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_item_profile_scope_fkey"
  FOREIGN KEY ("brand_profile_id", "workspace_id", "site_id")
  REFERENCES "brand_profile"("id", "workspace_id", "site_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_item_ref_scope_fkey"
  FOREIGN KEY ("evidence_ref_id", "workspace_id", "site_id", "brand_profile_id")
  REFERENCES "brand_profile_evidence_ref"("id", "workspace_id", "site_id", "brand_profile_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_item_evidence_scope_fkey"
  FOREIGN KEY ("evidence_id", "workspace_id", "claim_id")
  REFERENCES "evidence"("id", "workspace_id", "claim_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_item_source_scope_fkey"
  FOREIGN KEY ("source_snapshot_id", "workspace_id", "site_id", "source_content_hash")
  REFERENCES "site_evidence_source_snapshot"("id", "workspace_id", "site_id", "content_hash")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_publishable_claim_snapshot_item_cert_asset_scope_fkey"
  FOREIGN KEY ("cert_asset_id", "workspace_id", "site_id")
  REFERENCES "asset"("id", "workspace_id", "site_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE FUNCTION reject_site_publishable_claim_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PublishableClaimSnapshot rows are immutable';
END;
$$;

CREATE TRIGGER site_publishable_claim_snapshot_immutable
  BEFORE UPDATE ON "site_publishable_claim_snapshot"
  FOR EACH ROW EXECUTE FUNCTION reject_site_publishable_claim_snapshot_update();

CREATE TRIGGER site_publishable_claim_snapshot_item_immutable
  BEFORE UPDATE ON "site_publishable_claim_snapshot_item"
  FOR EACH ROW EXECUTE FUNCTION reject_site_publishable_claim_snapshot_update();

ALTER TABLE "site_publishable_claim_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_publishable_claim_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_publishable_claim_snapshot_tenant_isolation"
  ON "site_publishable_claim_snapshot"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "site_publishable_claim_snapshot_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_publishable_claim_snapshot_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_publishable_claim_snapshot_item_tenant_isolation"
  ON "site_publishable_claim_snapshot_item"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "site_publishable_claim_snapshot" FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE "site_publishable_claim_snapshot" FROM app_user;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_publishable_claim_snapshot" FROM app_user;
GRANT SELECT, INSERT ON TABLE "site_publishable_claim_snapshot" TO app_user;

REVOKE ALL ON TABLE "site_publishable_claim_snapshot_item" FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE "site_publishable_claim_snapshot_item" FROM app_user;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_publishable_claim_snapshot_item" FROM app_user;
GRANT SELECT, INSERT ON TABLE "site_publishable_claim_snapshot_item" TO app_user;
