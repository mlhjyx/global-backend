-- Historical Raw Source correction only. All helper/ACL DDL is isolated in
-- 1600/1700. Retained-size timing, lock rehearsal, and deployment remain HOLD.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- Advance projection provenance only when the current closed sanitizer changes
-- Canonical attributes.
UPDATE canonical_company AS company
SET attributes = public.sanitize_canonical_company_attributes_v3(
      company.attributes
    ),
    version = company.version + 1,
    updated_at = statement_timestamp()
WHERE company.attributes IS DISTINCT FROM
  public.sanitize_canonical_company_attributes_v3(company.attributes);

-- Preserve every evidence row and protected provenance. A v1 receipt carries
-- the original pre-cleanup digest forward unchanged and separately binds its
-- exact immediate predecessor bytes. A plain unsafe value has no predecessor
-- receipt and receives a digest derived directly from that value.
WITH receipt_candidates AS (
  SELECT evidence.id,
    evidence.field,
    evidence.value,
    CASE WHEN jsonb_typeof(evidence.value) = 'object' THEN
      public.raw_source_json_keys_within_v2(
        evidence.value,
        ARRAY['_historicalCleanup','reason','originalValueHash','retainedValue'],
        ARRAY['_historicalCleanup','reason','originalValueHash']
      )
      AND evidence.value->>'_historicalCleanup' =
        'canonical-attribute-cleanup/v1'
      AND evidence.value->>'reason' =
        'UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD'
      AND jsonb_typeof(evidence.value->'originalValueHash') = 'string'
      AND evidence.value->>'originalValueHash' ~ '^[0-9a-f]{64}$'
    ELSE false END AS is_v1_receipt
  FROM field_evidence AS evidence
  WHERE evidence.entity_type = 'company'
    AND NOT EXISTS (
      SELECT 1
      FROM raw_source_governance_disposition AS disposition
      WHERE disposition.workspace_id = evidence.workspace_id
        AND disposition.raw_record_id = evidence.raw_record_id
        AND disposition.effect = 'RESTRICT_PROCESSING'
    )
    -- A recognized current receipt is terminal. If a later field-aware rule
    -- rejects its retained value, leave it unchanged for an explicit future
    -- chained correction rather than misclassifying it as a plain value.
    AND NOT public.raw_source_cleanup_receipt_v2_shape_valid_v1(evidence.value)
    AND evidence.value IS DISTINCT FROM
      public.raw_source_sanitize_field_evidence_v4(
        evidence.field,evidence.value
      )
), sanitized_candidates AS (
  SELECT candidate.*,
    CASE
      WHEN candidate.is_v1_receipt
        AND candidate.value ? 'retainedValue'
      THEN public.raw_source_sanitize_field_evidence_plain_v5(
        candidate.field,
        candidate.value->'retainedValue'
      )
      WHEN candidate.is_v1_receipt THEN NULL
      ELSE public.raw_source_sanitize_field_evidence_v4(
        candidate.field,candidate.value
      )
    END AS retained_value
  FROM receipt_candidates AS candidate
)
UPDATE field_evidence AS evidence
SET value = jsonb_strip_nulls(jsonb_build_object(
      '_historicalCleanup', 'canonical-attribute-cleanup/v2',
      'reason', 'UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD',
      'originalValueHash', CASE
        WHEN candidate.is_v1_receipt
        THEN candidate.value->>'originalValueHash'
        ELSE encode(digest(
          public.raw_source_canonical_json_v1(candidate.value), 'sha256'
        ), 'hex')
      END,
      'predecessorReceiptHash', CASE
        WHEN candidate.is_v1_receipt
        THEN encode(digest(
          public.raw_source_canonical_json_v1(candidate.value), 'sha256'
        ), 'hex')
        ELSE NULL
      END,
      'retainedValue', CASE
        WHEN candidate.retained_value IS NOT NULL
          AND candidate.retained_value NOT IN ('{}'::jsonb,'[]'::jsonb)
        THEN candidate.retained_value
        ELSE NULL
      END
    )),
    allowed_actions = '[]'::jsonb,
    data_class = 'red'
FROM sanitized_candidates AS candidate
WHERE evidence.id = candidate.id;

COMMIT;
