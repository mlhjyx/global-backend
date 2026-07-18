-- R4-A2 Claim/Evidence truth bridge: additive, forward-only expand migration.
-- Historical Site rows deliberately remain unlinked (company_profile_id IS NULL):
-- no company identity can be inferred safely from a mutable display name.
-- Rollback is forward-only: first deploy readers that ignore these nullable fields/table,
-- then use a later migration to remove them only after proving no bridge rows exist.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

LOCK TABLE "company_profile" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "site" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "claim" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "evidence" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile_evidence_ref" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "asset" IN SHARE ROW EXCLUSIVE MODE;

-- Nullable expand only. New intake writes this link atomically; legacy rows fail closed
-- at the R4-A2 runtime gate until an explicit, audited repair establishes identity.
ALTER TABLE "site"
  ADD COLUMN "company_profile_id" UUID;

ALTER TABLE "claim"
  ADD COLUMN "origin_key" VARCHAR(64),
  ADD COLUMN "verified_by" TEXT,
  ADD COLUMN "verified_at" TIMESTAMP(3),
  ADD COLUMN "verification_method" TEXT,
  ADD COLUMN "verification_proof" JSONB,
  ADD CONSTRAINT "claim_origin_key_check"
    CHECK ("origin_key" IS NULL OR "origin_key" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "claim_human_verification_check"
    CHECK (
      (
        "verified_by" IS NULL
        AND "verified_at" IS NULL
        AND "verification_method" IS NULL
        AND "verification_proof" IS NULL
      )
      OR (
        "status" IN ('APPROVED', 'REVOKED', 'EXPIRED')
        AND char_length("verified_by") > 0
        AND "verified_at" IS NOT NULL
        AND "verification_method" = 'human_review'
        AND jsonb_typeof("verification_proof") = 'object'
      )
    );

ALTER TABLE "evidence"
  ADD COLUMN "origin_key" VARCHAR(64),
  ADD COLUMN "source_snapshot_id" UUID,
  ADD COLUMN "source_content_hash" VARCHAR(64),
  ADD COLUMN "quote_start" INTEGER,
  ADD COLUMN "quote_end" INTEGER,
  ADD COLUMN "quote_prefix" TEXT,
  ADD COLUMN "quote_suffix" TEXT,
  ADD COLUMN "asset_id" UUID,
  ADD CONSTRAINT "evidence_origin_key_check"
    CHECK ("origin_key" IS NULL OR "origin_key" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "evidence_source_content_hash_check"
    CHECK ("source_content_hash" IS NULL OR "source_content_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "evidence_quote_position_check"
    CHECK (
      ("quote_start" IS NULL AND "quote_end" IS NULL)
      OR (
        "quote_start" >= 0
        AND "quote_end" > "quote_start"
        AND "snippet" IS NOT NULL
        AND "quote_end" - "quote_start" = char_length("snippet")
      )
    ),
  ADD CONSTRAINT "evidence_quote_context_check"
    CHECK (
      ("quote_prefix" IS NULL OR char_length("quote_prefix") <= 32)
      AND ("quote_suffix" IS NULL OR char_length("quote_suffix") <= 32)
    );

CREATE UNIQUE INDEX "company_profile_id_workspace_id_key"
  ON "company_profile"("id", "workspace_id");
CREATE UNIQUE INDEX "claim_company_origin_key"
  ON "claim"("company_id", "origin_key");
CREATE UNIQUE INDEX "claim_id_workspace_company_key"
  ON "claim"("id", "workspace_id", "company_id");
CREATE UNIQUE INDEX "evidence_claim_origin_key"
  ON "evidence"("claim_id", "origin_key");
CREATE UNIQUE INDEX "evidence_id_workspace_claim_key"
  ON "evidence"("id", "workspace_id", "claim_id");
CREATE UNIQUE INDEX "brand_profile_evidence_ref_scope_profile_key"
  ON "brand_profile_evidence_ref"("id", "workspace_id", "site_id", "brand_profile_id");

ALTER TABLE "site"
  ADD CONSTRAINT "site_company_profile_workspace_fkey"
    FOREIGN KEY ("company_profile_id", "workspace_id")
    REFERENCES "company_profile"("id", "workspace_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE "brand_profile_claim_bridge" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "company_profile_id" UUID NOT NULL,
  "brand_profile_id" UUID NOT NULL,
  "evidence_ref_id" UUID NOT NULL,
  "fact_index" INTEGER NOT NULL,
  "claim_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "cert_asset_id" UUID,
  "bridge_key" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "brand_profile_claim_bridge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brand_profile_claim_bridge_fact_index_check"
    CHECK ("fact_index" >= 0),
  CONSTRAINT "brand_profile_claim_bridge_key_check"
    CHECK ("bridge_key" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "brand_profile_claim_bridge_scope_key"
  ON "brand_profile_claim_bridge"("workspace_id", "site_id", "bridge_key");
CREATE UNIQUE INDEX "brand_profile_claim_bridge_profile_ref_key"
  ON "brand_profile_claim_bridge"("brand_profile_id", "evidence_ref_id");
CREATE UNIQUE INDEX "brand_profile_claim_bridge_profile_fact_key"
  ON "brand_profile_claim_bridge"("brand_profile_id", "fact_index");
CREATE INDEX "brand_profile_claim_bridge_company_claim_idx"
  ON "brand_profile_claim_bridge"("workspace_id", "company_profile_id", "claim_id");

ALTER TABLE "brand_profile_claim_bridge"
  ADD CONSTRAINT "brand_profile_claim_bridge_site_scope_fkey"
    FOREIGN KEY ("site_id", "workspace_id")
    REFERENCES "site"("id", "workspace_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "brand_profile_claim_bridge_company_scope_fkey"
    FOREIGN KEY ("company_profile_id", "workspace_id")
    REFERENCES "company_profile"("id", "workspace_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "brand_profile_claim_bridge_profile_scope_fkey"
    FOREIGN KEY ("brand_profile_id", "workspace_id", "site_id")
    REFERENCES "brand_profile"("id", "workspace_id", "site_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "brand_profile_claim_bridge_evidence_ref_scope_fkey"
    FOREIGN KEY ("evidence_ref_id", "workspace_id", "site_id", "brand_profile_id")
    REFERENCES "brand_profile_evidence_ref"("id", "workspace_id", "site_id", "brand_profile_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "brand_profile_claim_bridge_claim_scope_fkey"
    FOREIGN KEY ("claim_id", "workspace_id", "company_profile_id")
    REFERENCES "claim"("id", "workspace_id", "company_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "brand_profile_claim_bridge_evidence_scope_fkey"
    FOREIGN KEY ("evidence_id", "workspace_id", "claim_id")
    REFERENCES "evidence"("id", "workspace_id", "claim_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "brand_profile_claim_bridge_cert_asset_scope_fkey"
    FOREIGN KEY ("cert_asset_id", "workspace_id", "site_id")
    REFERENCES "asset"("id", "workspace_id", "site_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Direct updates are forbidden for every role; owner-level cascades remain available
-- for the existing Site/Company retention and deletion paths.
CREATE FUNCTION reject_brand_profile_claim_bridge_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'BrandProfile Claim bridge is immutable after insert';
END
$$;

CREATE TRIGGER brand_profile_claim_bridge_immutable
  BEFORE UPDATE ON "brand_profile_claim_bridge"
  FOR EACH ROW EXECUTE FUNCTION reject_brand_profile_claim_bridge_update();

ALTER TABLE "brand_profile_claim_bridge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_profile_claim_bridge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "brand_profile_claim_bridge_tenant_isolation"
  ON "brand_profile_claim_bridge"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "brand_profile_claim_bridge" FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE "brand_profile_claim_bridge" FROM app_user;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "brand_profile_claim_bridge" FROM app_user;
GRANT SELECT, INSERT ON TABLE "brand_profile_claim_bridge" TO app_user;
