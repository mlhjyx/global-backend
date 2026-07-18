-- Prisma DateTime is PostgreSQL TIMESTAMP(3) WITHOUT TIME ZONE. EvidenceRefV2
-- serializes fetchedAt as ISO-8601 UTC, so normalize the embedded instant to a
-- UTC wall-clock timestamp before comparison; never depend on session TimeZone.

CREATE OR REPLACE FUNCTION assert_brand_profile_claim_evidence_origin_v2(
  p_workspace_id UUID,
  p_site_id UUID,
  p_brand_profile_id UUID,
  p_evidence_ref_id UUID,
  p_fact_index INTEGER,
  p_claim_id UUID,
  p_evidence_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  fact_evidence JSONB;
  fact_selector JSONB;
  ref_row "brand_profile_evidence_ref"%ROWTYPE;
  snapshot_row "site_evidence_source_snapshot"%ROWTYPE;
  evidence_row "evidence"%ROWTYPE;
  expected_asset_id TEXT;
  embedded_fetched_at TIMESTAMP;
BEGIN
  SELECT "fact_sheet" -> p_fact_index -> 'evidence' INTO fact_evidence
  FROM "brand_profile"
  WHERE "id" = p_brand_profile_id
    AND "workspace_id" = p_workspace_id
    AND "site_id" = p_site_id;

  SELECT * INTO ref_row
  FROM "brand_profile_evidence_ref"
  WHERE "id" = p_evidence_ref_id
    AND "workspace_id" = p_workspace_id
    AND "site_id" = p_site_id
    AND "brand_profile_id" = p_brand_profile_id;

  SELECT * INTO snapshot_row
  FROM "site_evidence_source_snapshot"
  WHERE "id" = ref_row."source_snapshot_id"
    AND "workspace_id" = p_workspace_id
    AND "site_id" = p_site_id
    AND "content_hash" = ref_row."source_content_hash";

  SELECT * INTO evidence_row
  FROM "evidence"
  WHERE "id" = p_evidence_id
    AND "workspace_id" = p_workspace_id
    AND "claim_id" = p_claim_id;

  IF ref_row."id" IS NULL
    OR snapshot_row."id" IS NULL
    OR evidence_row."id" IS NULL
    OR jsonb_typeof(fact_evidence) IS DISTINCT FROM 'object'
    OR jsonb_typeof(fact_evidence -> 'selector') IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'claim bridge EvidenceRefV2 origin is incomplete';
  END IF;

  fact_selector := fact_evidence -> 'selector';
  expected_asset_id := snapshot_row."provenance" ->> 'assetId';

  IF fact_evidence - ARRAY[
      'version', 'evidenceRefId', 'sourceId', 'sourceType', 'sourceRole',
      'hashAlgorithm', 'contentHash', 'quote', 'selector', 'assetId', 'url',
      'fetchedAt'
    ] IS DISTINCT FROM '{}'::jsonb
    OR fact_selector - ARRAY['start', 'end', 'prefix', 'suffix']
      IS DISTINCT FROM '{}'::jsonb
    OR jsonb_typeof(fact_evidence -> 'version') IS DISTINCT FROM 'number'
    OR fact_evidence -> 'version' IS DISTINCT FROM '2'::jsonb
    OR jsonb_typeof(fact_evidence -> 'evidenceRefId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_evidence -> 'sourceId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_evidence -> 'sourceType') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_evidence -> 'sourceRole') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_evidence -> 'hashAlgorithm') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_evidence -> 'contentHash') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_evidence -> 'quote') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_selector -> 'start') IS DISTINCT FROM 'number'
    OR jsonb_typeof(fact_selector -> 'end') IS DISTINCT FROM 'number'
  THEN
    RAISE EXCEPTION 'claim bridge EvidenceRefV2 JSON contract is invalid';
  END IF;

  IF (ref_row."quote_prefix" IS NULL) IS DISTINCT FROM NOT (fact_selector ? 'prefix')
    OR (fact_selector ? 'prefix' AND jsonb_typeof(fact_selector -> 'prefix') IS DISTINCT FROM 'string')
    OR (ref_row."quote_suffix" IS NULL) IS DISTINCT FROM NOT (fact_selector ? 'suffix')
    OR (fact_selector ? 'suffix' AND jsonb_typeof(fact_selector -> 'suffix') IS DISTINCT FROM 'string')
    OR (expected_asset_id IS NULL) IS DISTINCT FROM NOT (fact_evidence ? 'assetId')
    OR (fact_evidence ? 'assetId' AND jsonb_typeof(fact_evidence -> 'assetId') IS DISTINCT FROM 'string')
    OR (snapshot_row."display_url" IS NULL) IS DISTINCT FROM NOT (fact_evidence ? 'url')
    OR (fact_evidence ? 'url' AND jsonb_typeof(fact_evidence -> 'url') IS DISTINCT FROM 'string')
    OR fact_evidence ->> 'url' IS DISTINCT FROM snapshot_row."display_url"
  THEN
    RAISE EXCEPTION 'claim bridge EvidenceRefV2 optional origin metadata is not exact';
  END IF;

  IF snapshot_row."fetched_at" IS NULL THEN
    IF fact_evidence ? 'fetchedAt' THEN
      RAISE EXCEPTION 'claim bridge EvidenceRefV2 optional origin metadata is not exact';
    END IF;
  ELSE
    IF NOT (fact_evidence ? 'fetchedAt')
      OR jsonb_typeof(fact_evidence -> 'fetchedAt') IS DISTINCT FROM 'string'
    THEN
      RAISE EXCEPTION 'claim bridge EvidenceRefV2 optional origin metadata is not exact';
    END IF;
    BEGIN
      embedded_fetched_at :=
        (fact_evidence ->> 'fetchedAt')::timestamptz AT TIME ZONE 'UTC';
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'claim bridge EvidenceRefV2 fetchedAt is invalid';
    END;
    IF embedded_fetched_at IS DISTINCT FROM snapshot_row."fetched_at" THEN
      RAISE EXCEPTION 'claim bridge EvidenceRefV2 optional origin metadata is not exact';
    END IF;
  END IF;

  IF evidence_row."source_url" IS DISTINCT FROM snapshot_row."display_url"
    OR evidence_row."fetched_at" IS DISTINCT FROM snapshot_row."fetched_at"
  THEN
    RAISE EXCEPTION 'claim bridge Evidence origin does not match source snapshot';
  END IF;
END
$$;
