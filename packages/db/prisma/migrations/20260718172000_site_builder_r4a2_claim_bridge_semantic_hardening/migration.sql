-- R4-A2 semantic hardening after the two additive bridge migrations were applied.
-- This forward migration makes direct app-role INSERTs obey the same fact/source
-- contract as the runtime service and makes a human approval audit durable.
-- Rollback is forward-only: deploy readers that ignore bridge rows, then ship a
-- later migration only after proving no approved consumer depends on these guards.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

CREATE FUNCTION normalize_brand_claim_identity(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT btrim(regexp_replace(normalize(value, NFKC), '[[:space:]]+', ' ', 'g'))
$$;

-- SQL mirror of claimTypeForBrandFact. Any classifier change must update this
-- function in a forward migration before the application change is deployed.
CREATE FUNCTION claim_type_for_brand_fact(fact_key TEXT, fact_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  normalized TEXT := lower(
    normalize_brand_claim_identity(fact_key || ' ' || fact_value)
  );
BEGIN
  IF normalized ~
    '(certif|certificate|accredit|认证|证书|资质|(^|[^a-z0-9])(iso|iec|en|din|iatf|as|api|astm|gb|ul)[[:space:]]*[-:/]?[[:space:]]*[0-9]|(^|[^a-z0-9])(ce|fda|ul|rohs|reach|gmp|tüv)([^a-z0-9]|$))'
  THEN
    RETURN 'certification';
  ELSIF normalized ~ '(case|customer|client|project|案例|客户|项目)' THEN
    RETURN 'case';
  ELSIF normalized ~
    '(pressure|capacity|frequency|voltage|power|speed|temperature|dimension|weight|性能|参数|压力|产能|频率|电压|功率|转速|温度|尺寸|重量)'
    OR normalized ~
      '[0-9][[:space:]]*(%|bar|mbar|pa|kpa|mpa|psi|hz|khz|mhz|ghz|rpm|v|kv|a|kw|mw|mm|cm|km|kg|lb|l|m[23²³])([^a-z0-9]|$)'
  THEN
    RETURN 'param';
  ELSIF normalized ~ '(value[_[:space:]-]?prop|价值主张)' THEN
    RETURN 'value_prop';
  END IF;
  RETURN 'capability';
END
$$;

CREATE FUNCTION assert_brand_profile_claim_bridge_semantics(
  p_workspace_id UUID,
  p_site_id UUID,
  p_company_profile_id UUID,
  p_brand_profile_id UUID,
  p_evidence_ref_id UUID,
  p_fact_index INTEGER,
  p_claim_id UUID,
  p_evidence_id UUID,
  p_cert_asset_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  ref_row "brand_profile_evidence_ref"%ROWTYPE;
  evidence_row "evidence"%ROWTYPE;
  snapshot_row "site_evidence_source_snapshot"%ROWTYPE;
  claim_row "claim"%ROWTYPE;
  cert_asset_row "asset"%ROWTYPE;
  fact_row JSONB;
  fact_evidence JSONB;
  fact_key TEXT;
  fact_value TEXT;
  expected_claim_type TEXT;
  expected_asset_id TEXT;
BEGIN
  SELECT * INTO ref_row
  FROM "brand_profile_evidence_ref"
  WHERE "id" = p_evidence_ref_id
    AND "workspace_id" = p_workspace_id
    AND "site_id" = p_site_id
    AND "brand_profile_id" = p_brand_profile_id;

  SELECT * INTO evidence_row
  FROM "evidence"
  WHERE "id" = p_evidence_id
    AND "workspace_id" = p_workspace_id
    AND "claim_id" = p_claim_id;

  SELECT * INTO snapshot_row
  FROM "site_evidence_source_snapshot"
  WHERE "id" = ref_row."source_snapshot_id"
    AND "workspace_id" = p_workspace_id
    AND "site_id" = p_site_id
    AND "content_hash" = ref_row."source_content_hash";

  SELECT * INTO claim_row
  FROM "claim"
  WHERE "id" = p_claim_id
    AND "workspace_id" = p_workspace_id
    AND "company_id" = p_company_profile_id;

  SELECT "fact_sheet" -> p_fact_index INTO fact_row
  FROM "brand_profile"
  WHERE "id" = p_brand_profile_id
    AND "workspace_id" = p_workspace_id
    AND "site_id" = p_site_id;

  IF ref_row."id" IS NULL
    OR evidence_row."id" IS NULL
    OR snapshot_row."id" IS NULL
    OR claim_row."id" IS NULL
    OR jsonb_typeof(fact_row) IS DISTINCT FROM 'object'
    OR jsonb_typeof(fact_row -> 'key') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_row -> 'value') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_row -> 'evidence') IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'claim bridge exact identity is incomplete';
  END IF;

  fact_key := fact_row ->> 'key';
  fact_value := fact_row ->> 'value';
  fact_evidence := fact_row -> 'evidence';

  IF p_fact_index IS DISTINCT FROM ref_row."fact_index"
    OR ref_row."fact_key" IS DISTINCT FROM fact_key
    OR fact_evidence ->> 'evidenceRefId' IS DISTINCT FROM p_evidence_ref_id::text
    OR fact_evidence ->> 'sourceId' IS DISTINCT FROM ref_row."source_snapshot_id"::text
    OR fact_evidence ->> 'sourceRole' IS DISTINCT FROM snapshot_row."source_role"
    OR fact_evidence ->> 'contentHash' IS DISTINCT FROM ref_row."source_content_hash"
    OR fact_evidence ->> 'quote' IS DISTINCT FROM ref_row."quote"
    OR fact_evidence -> 'selector' ->> 'start' IS DISTINCT FROM ref_row."quote_start"::text
    OR fact_evidence -> 'selector' ->> 'end' IS DISTINCT FROM ref_row."quote_end"::text
    OR evidence_row."source_snapshot_id" IS DISTINCT FROM ref_row."source_snapshot_id"
    OR evidence_row."source_content_hash" IS DISTINCT FROM ref_row."source_content_hash"
    OR evidence_row."snippet" IS DISTINCT FROM ref_row."quote"
    OR evidence_row."quote_start" IS DISTINCT FROM ref_row."quote_start"
    OR evidence_row."quote_end" IS DISTINCT FROM ref_row."quote_end"
    OR evidence_row."quote_prefix" IS DISTINCT FROM ref_row."quote_prefix"
    OR evidence_row."quote_suffix" IS DISTINCT FROM ref_row."quote_suffix"
    OR substring(
      snapshot_row."snapshot_text"
      FROM ref_row."quote_start" + 1
      FOR ref_row."quote_end" - ref_row."quote_start"
    ) IS DISTINCT FROM ref_row."quote"
  THEN
    RAISE EXCEPTION 'claim bridge Evidence does not match its exact EvidenceRef';
  END IF;

  IF snapshot_row."source_role" IS DISTINCT FROM 'fact_candidate' THEN
    RAISE EXCEPTION 'claim bridge research_hint is not publishable';
  END IF;

  expected_claim_type := claim_type_for_brand_fact(fact_key, fact_value);
  IF claim_row."statement" IS DISTINCT FROM normalize_brand_claim_identity(fact_value)
    OR claim_row."type" IS DISTINCT FROM expected_claim_type
  THEN
    RAISE EXCEPTION 'claim bridge Claim does not match its exact BrandProfile fact';
  END IF;

  expected_asset_id := snapshot_row."provenance" ->> 'assetId';
  IF evidence_row."asset_id"::text IS DISTINCT FROM expected_asset_id THEN
    RAISE EXCEPTION 'claim bridge Evidence asset does not match source provenance';
  END IF;

  IF expected_claim_type = 'certification' AND p_cert_asset_id IS NULL THEN
    RAISE EXCEPTION 'certification claim requires frozen cert asset proof';
  ELSIF expected_claim_type <> 'certification' AND p_cert_asset_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-certification claim cannot carry cert asset proof';
  END IF;

  IF p_cert_asset_id IS NOT NULL THEN
    SELECT * INTO cert_asset_row
    FROM "asset"
    WHERE "id" = p_cert_asset_id
      AND "workspace_id" = p_workspace_id
      AND "site_id" = p_site_id;

    IF cert_asset_row."id" IS NULL
      OR evidence_row."asset_id" IS DISTINCT FROM p_cert_asset_id
      OR expected_asset_id IS DISTINCT FROM p_cert_asset_id::text
      OR cert_asset_row."kind" IS DISTINCT FROM 'cert'
      OR cert_asset_row."processing_status" IS DISTINCT FROM 'ready'
      OR cert_asset_row."deleted_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'claim bridge certification asset is not exact publishable proof';
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION validate_brand_profile_claim_bridge_exact_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_brand_profile_claim_bridge_semantics(
    NEW."workspace_id",
    NEW."site_id",
    NEW."company_profile_id",
    NEW."brand_profile_id",
    NEW."evidence_ref_id",
    NEW."fact_index",
    NEW."claim_id",
    NEW."evidence_id",
    NEW."cert_asset_id"
  );
  RETURN NEW;
END
$$;

-- Fail closed if any bridge was inserted between the earlier additive migration
-- and this semantic hardening migration. On a clean rollout this loop is empty.
DO $$
DECLARE
  bridge_row "brand_profile_claim_bridge"%ROWTYPE;
BEGIN
  FOR bridge_row IN SELECT * FROM "brand_profile_claim_bridge" LOOP
    PERFORM assert_brand_profile_claim_bridge_semantics(
      bridge_row."workspace_id",
      bridge_row."site_id",
      bridge_row."company_profile_id",
      bridge_row."brand_profile_id",
      bridge_row."evidence_ref_id",
      bridge_row."fact_index",
      bridge_row."claim_id",
      bridge_row."evidence_id",
      bridge_row."cert_asset_id"
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION reject_bridged_claim_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_changed BOOLEAN := ROW(
    NEW."verified_by", NEW."verified_at", NEW."verification_method",
    NEW."verification_proof"
  ) IS DISTINCT FROM ROW(
    OLD."verified_by", OLD."verified_at", OLD."verification_method",
    OLD."verification_proof"
  );
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

  IF audit_changed AND NOT (
    OLD."status" = 'NEEDS_REVIEW'
    AND NEW."status" = 'APPROVED'
    AND NEW."version" = OLD."version" + 1
    AND OLD."verified_by" IS NULL
    AND OLD."verified_at" IS NULL
    AND OLD."verification_method" IS NULL
    AND OLD."verification_proof" IS NULL
    AND nullif(btrim(NEW."verified_by"), '') IS NOT NULL
    AND NEW."verified_at" IS NOT NULL
    AND NEW."verification_method" = 'human_review'
    AND jsonb_typeof(NEW."verification_proof") = 'object'
    AND NEW."verification_proof" ->> 'action' = 'claim_approval'
    AND NEW."verification_proof" ->> 'proofVersion' = '2'
    AND NEW."verification_proof" ->> 'approvedVersion' = NEW."version"::text
  ) THEN
    RAISE EXCEPTION 'Claim approval audit is immutable after initial approval';
  END IF;

  RETURN NEW;
END
$$;
