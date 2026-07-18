-- R4-A2 freezes the server-owned Claim classification with each append-only
-- BrandProfile fact. PostgreSQL validates that frozen contract; it must not
-- maintain a second, drift-prone copy of the TypeScript classifier.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

-- Close the preflight race. Reference tables are locked in application write
-- order, then the bridge table; any in-flight writer either commits before the
-- snapshot and is validated below, or waits and is checked by the new trigger.
LOCK TABLE "brand_profile" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile_evidence_ref" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "site_evidence_source_snapshot" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "claim" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "evidence" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "asset" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile_claim_bridge" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION assert_brand_profile_claim_bridge_semantics(
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
  fact_selector JSONB;
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
    OR jsonb_typeof(fact_row -> 'claimType') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_row -> 'evidence') IS DISTINCT FROM 'object'
    OR jsonb_typeof(fact_row -> 'evidence' -> 'selector') IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'claim bridge exact identity is incomplete';
  END IF;

  fact_key := fact_row ->> 'key';
  fact_value := fact_row ->> 'value';
  expected_claim_type := fact_row ->> 'claimType';
  fact_evidence := fact_row -> 'evidence';
  fact_selector := fact_evidence -> 'selector';
  expected_asset_id := snapshot_row."provenance" ->> 'assetId';

  IF expected_claim_type NOT IN (
      'certification', 'case', 'param', 'value_prop', 'capability'
    )
    OR p_fact_index IS DISTINCT FROM ref_row."fact_index"
    OR ref_row."fact_key" IS DISTINCT FROM fact_key
    OR fact_evidence ->> 'version' IS DISTINCT FROM '2'
    OR fact_evidence ->> 'evidenceRefId' IS DISTINCT FROM p_evidence_ref_id::text
    OR fact_evidence ->> 'sourceId' IS DISTINCT FROM ref_row."source_snapshot_id"::text
    OR fact_evidence ->> 'sourceType' IS DISTINCT FROM snapshot_row."source_type"
    OR fact_evidence ->> 'sourceRole' IS DISTINCT FROM snapshot_row."source_role"
    OR fact_evidence ->> 'hashAlgorithm' IS DISTINCT FROM snapshot_row."hash_algorithm"
    OR fact_evidence ->> 'contentHash' IS DISTINCT FROM ref_row."source_content_hash"
    OR fact_evidence ->> 'quote' IS DISTINCT FROM ref_row."quote"
    OR fact_selector ->> 'start' IS DISTINCT FROM ref_row."quote_start"::text
    OR fact_selector ->> 'end' IS DISTINCT FROM ref_row."quote_end"::text
    OR fact_selector ->> 'prefix' IS DISTINCT FROM ref_row."quote_prefix"
    OR fact_selector ->> 'suffix' IS DISTINCT FROM ref_row."quote_suffix"
    OR fact_evidence ->> 'assetId' IS DISTINCT FROM expected_asset_id
  THEN
    RAISE EXCEPTION 'claim bridge EvidenceRefV2 metadata does not match frozen source/ref';
  END IF;

  IF evidence_row."source_snapshot_id" IS DISTINCT FROM ref_row."source_snapshot_id"
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

  IF claim_row."statement" IS DISTINCT FROM normalize_brand_claim_identity(fact_value)
    OR claim_row."type" IS DISTINCT FROM expected_claim_type
  THEN
    RAISE EXCEPTION 'claim bridge Claim does not match its exact BrandProfile fact';
  END IF;

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

-- Validate every committed edge while writes are excluded by the locks above.
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

-- BrandProfile v2, its exact EvidenceRef and frozen source are append-only.
-- The app role has no legitimate update path; owner-level retention cascades
-- remain available, while direct owner updates of bridged rows fail closed.
REVOKE UPDATE ON TABLE "brand_profile" FROM app_user;
REVOKE UPDATE ON TABLE "brand_profile_evidence_ref" FROM app_user;
REVOKE UPDATE ON TABLE "site_evidence_source_snapshot" FROM app_user;

CREATE FUNCTION reject_bridged_brand_profile_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "brand_profile_claim_bridge"
    WHERE "brand_profile_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'bridged BrandProfile is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bridged_brand_profile_immutable
  BEFORE UPDATE ON "brand_profile"
  FOR EACH ROW EXECUTE FUNCTION reject_bridged_brand_profile_update();

CREATE FUNCTION reject_bridged_brand_profile_evidence_ref_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "brand_profile_claim_bridge"
    WHERE "evidence_ref_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'bridged BrandProfile EvidenceRef is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bridged_brand_profile_evidence_ref_immutable
  BEFORE UPDATE ON "brand_profile_evidence_ref"
  FOR EACH ROW EXECUTE FUNCTION reject_bridged_brand_profile_evidence_ref_update();

CREATE FUNCTION reject_bridged_source_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "brand_profile_evidence_ref" ref
    JOIN "brand_profile_claim_bridge" bridge
      ON bridge."evidence_ref_id" = ref."id"
    WHERE ref."source_snapshot_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'bridged Evidence source snapshot is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bridged_source_snapshot_immutable
  BEFORE UPDATE ON "site_evidence_source_snapshot"
  FOR EACH ROW EXECUTE FUNCTION reject_bridged_source_snapshot_update();

-- No runtime or database path may use the drift-prone SQL classifier now.
DROP FUNCTION claim_type_for_brand_fact(TEXT, TEXT);
