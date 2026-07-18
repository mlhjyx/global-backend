-- R4-A2 hardening after the additive bridge migration was already applied.
-- Production rollout gate: measure site/evidence/claim/bridge row counts and index
-- build duration on a restored snapshot, then schedule a maintenance window if the
-- five-second lock budget cannot be met. This migration does not claim deployment.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

-- Bind every bridge to the exact CompanyProfile already linked by its Site.
CREATE UNIQUE INDEX "site_id_workspace_company_key"
  ON "site"("id", "workspace_id", "company_profile_id");

ALTER TABLE "brand_profile_claim_bridge"
  DROP CONSTRAINT "brand_profile_claim_bridge_site_scope_fkey",
  ADD CONSTRAINT "brand_profile_claim_bridge_site_scope_fkey"
    FOREIGN KEY ("site_id", "workspace_id", "company_profile_id")
    REFERENCES "site"("id", "workspace_id", "company_profile_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
    NOT VALID;

ALTER TABLE "brand_profile_claim_bridge"
  VALIDATE CONSTRAINT "brand_profile_claim_bridge_site_scope_fkey";

-- PostgreSQL CHECK accepts UNKNOWN, so make the paired-null invariant explicit.
ALTER TABLE "evidence"
  DROP CONSTRAINT "evidence_quote_position_check",
  ADD CONSTRAINT "evidence_quote_position_check"
    CHECK (
      ("quote_start" IS NULL AND "quote_end" IS NULL)
      OR (
        "quote_start" IS NOT NULL AND "quote_end" IS NOT NULL
        AND "quote_start" >= 0
        AND "quote_end" > "quote_start"
        AND "snippet" IS NOT NULL
        AND "quote_end" - "quote_start" = char_length("snippet")
      )
    );

-- The bridge row is append-only; this trigger also proves that each inserted edge
-- points at byte-identical public Evidence and its exact frozen EvidenceRef.
CREATE FUNCTION validate_brand_profile_claim_bridge_exact_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_row "brand_profile_evidence_ref"%ROWTYPE;
  evidence_row "evidence"%ROWTYPE;
  snapshot_row "site_evidence_source_snapshot"%ROWTYPE;
  claim_row "claim"%ROWTYPE;
  cert_asset_row "asset"%ROWTYPE;
  certification_claim BOOLEAN;
BEGIN
  SELECT * INTO ref_row
  FROM "brand_profile_evidence_ref"
  WHERE "id" = NEW."evidence_ref_id"
    AND "workspace_id" = NEW."workspace_id"
    AND "site_id" = NEW."site_id"
    AND "brand_profile_id" = NEW."brand_profile_id";

  SELECT * INTO evidence_row
  FROM "evidence"
  WHERE "id" = NEW."evidence_id"
    AND "workspace_id" = NEW."workspace_id"
    AND "claim_id" = NEW."claim_id";

  SELECT * INTO snapshot_row
  FROM "site_evidence_source_snapshot"
  WHERE "id" = ref_row."source_snapshot_id"
    AND "workspace_id" = NEW."workspace_id"
    AND "site_id" = NEW."site_id"
    AND "content_hash" = ref_row."source_content_hash";

  SELECT * INTO claim_row
  FROM "claim"
  WHERE "id" = NEW."claim_id"
    AND "workspace_id" = NEW."workspace_id"
    AND "company_id" = NEW."company_profile_id";

  IF NOT FOUND
    OR ref_row."id" IS NULL
    OR evidence_row."id" IS NULL
    OR snapshot_row."id" IS NULL
    OR claim_row."id" IS NULL
  THEN
    RAISE EXCEPTION 'claim bridge exact identity is incomplete';
  END IF;

  IF NEW."fact_index" IS DISTINCT FROM ref_row."fact_index"
    OR evidence_row."source_snapshot_id" IS DISTINCT FROM ref_row."source_snapshot_id"
    OR evidence_row."source_content_hash" IS DISTINCT FROM ref_row."source_content_hash"
    OR evidence_row."snippet" IS DISTINCT FROM ref_row."quote"
    OR evidence_row."quote_start" IS DISTINCT FROM ref_row."quote_start"
    OR evidence_row."quote_end" IS DISTINCT FROM ref_row."quote_end"
    OR evidence_row."quote_prefix" IS DISTINCT FROM ref_row."quote_prefix"
    OR evidence_row."quote_suffix" IS DISTINCT FROM ref_row."quote_suffix"
  THEN
    RAISE EXCEPTION 'claim bridge Evidence does not match its exact EvidenceRef';
  END IF;

  certification_claim :=
    lower(claim_row."type" || ' ' || claim_row."statement") ~
      '(certif|certificate|accredit|认证|证书|资质|(^|[^a-z0-9])(iso|iec|en|din|iatf|as|api|astm|gb|ul)[[:space:]]*[-:/]?[[:space:]]*[0-9]|(^|[^a-z0-9])(ce|fda|ul|rohs|reach|gmp|tüv)([^a-z0-9]|$))';

  IF certification_claim AND NEW."cert_asset_id" IS NULL THEN
    RAISE EXCEPTION 'certification claim requires frozen cert asset proof';
  END IF;

  IF NEW."cert_asset_id" IS NOT NULL THEN
    SELECT * INTO cert_asset_row
    FROM "asset"
    WHERE "id" = NEW."cert_asset_id"
      AND "workspace_id" = NEW."workspace_id"
      AND "site_id" = NEW."site_id";

    IF cert_asset_row."id" IS NULL
      OR NOT certification_claim
      OR evidence_row."asset_id" IS DISTINCT FROM NEW."cert_asset_id"
      OR snapshot_row."source_role" IS DISTINCT FROM 'fact_candidate'
      OR snapshot_row."provenance"->>'assetId' IS DISTINCT FROM NEW."cert_asset_id"::text
      OR cert_asset_row."kind" IS DISTINCT FROM 'cert'
      OR cert_asset_row."processing_status" IS DISTINCT FROM 'ready'
      OR cert_asset_row."deleted_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'claim bridge certification asset is not exact publishable proof';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER brand_profile_claim_bridge_exact_evidence
  BEFORE INSERT ON "brand_profile_claim_bridge"
  FOR EACH ROW EXECUTE FUNCTION validate_brand_profile_claim_bridge_exact_evidence();

-- Approval may change lifecycle/audit columns, but bridged or terminal content
-- identity cannot be rewritten underneath a durable human approval.
CREATE FUNCTION reject_bridged_claim_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM "brand_profile_claim_bridge"
      WHERE "claim_id" = OLD."id"
    ) OR OLD."status" IN ('APPROVED', 'REVOKED', 'EXPIRED')
  THEN
    IF ROW(
      NEW."workspace_id", NEW."company_id", NEW."source_id", NEW."origin_key",
      NEW."type", NEW."statement", NEW."confidence", NEW."valid_until"
    ) IS DISTINCT FROM ROW(
      OLD."workspace_id", OLD."company_id", OLD."source_id", OLD."origin_key",
      OLD."type", OLD."statement", OLD."confidence", OLD."valid_until"
    ) THEN
      RAISE EXCEPTION 'bridged or terminal Claim identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bridged_claim_identity_immutable
  BEFORE UPDATE ON "claim"
  FOR EACH ROW EXECUTE FUNCTION reject_bridged_claim_identity_update();

CREATE FUNCTION reject_bridged_evidence_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM "brand_profile_claim_bridge"
      WHERE "evidence_id" = OLD."id"
    ) OR EXISTS (
      SELECT 1 FROM "claim"
      WHERE "id" = OLD."claim_id"
        AND "status" IN ('APPROVED', 'REVOKED', 'EXPIRED')
    )
  THEN
    RAISE EXCEPTION 'bridged or terminal Evidence is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bridged_evidence_immutable
  BEFORE UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION reject_bridged_evidence_update();

REVOKE UPDATE, DELETE ON TABLE "evidence" FROM app_user;
REVOKE DELETE ON TABLE "claim" FROM app_user;
