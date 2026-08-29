-- Pre-release reissue of the historical stored-FieldEvidence correction using
-- the closed adapter and value-free audit surface installed by 2100. The prior
-- 2200 checksum was never pushed/applied to retained data and is checker-HOLD.
-- This migration is DML-only, preserves provenance columns/times and
-- restrictive evidence bytes, and remains HOLD for retained application.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

WITH source_rows AS MATERIALIZED (
  SELECT evidence.id,
    evidence.workspace_id,
    evidence.entity_id,
    evidence.field,
    evidence.value,
    evidence.provider_key,
    evidence.raw_record_id,
    evidence.allowed_actions,
    evidence.data_class,
    evidence.fetched_at,
    company.attributes AS canonical_attributes,
    raw.payload AS raw_payload,
    public.raw_source_known_cleanup_receipt_v1(evidence.value)
      AS known_receipt
  FROM field_evidence AS evidence
  LEFT JOIN canonical_company AS company
    ON company.workspace_id=evidence.workspace_id
   AND company.id=evidence.entity_id
  LEFT JOIN raw_source_record AS raw
    ON raw.workspace_id=evidence.workspace_id
   AND raw.id=evidence.raw_record_id
  WHERE evidence.entity_type='company'
    AND NOT EXISTS (
      SELECT 1
      FROM raw_source_governance_disposition AS disposition
      WHERE disposition.workspace_id=evidence.workspace_id
        AND disposition.raw_record_id=evidence.raw_record_id
        AND disposition.effect='RESTRICT_PROCESSING'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM raw_source_field_evidence_cleanup_audit AS audit
      WHERE audit.field_evidence_id=evidence.id
        AND audit.cleanup_contract='raw-source-stored-field-cleanup/v1'
        AND audit.adapter_version='stored-company-field-evidence/v1'
    )
), normalized AS MATERIALIZED (
  SELECT source.*,
    CASE WHEN source.known_receipt
      THEN source.value->>'originalValueHash'
      ELSE encode(digest(
        public.raw_source_canonical_json_v1(source.value),'sha256'
      ),'hex')
    END AS original_value_hash,
    CASE WHEN source.known_receipt
      THEN source.value->>'predecessorReceiptHash'
      ELSE NULL
    END AS predecessor_receipt_hash,
    CASE WHEN source.known_receipt THEN encode(digest(
      public.raw_source_canonical_json_v1(source.value),'sha256'
    ),'hex') ELSE NULL END AS current_receipt_hash,
    public.raw_source_sanitize_stored_company_field_evidence_v1(
      source.field,source.value
    ) AS direct_sanitized_value,
    CASE WHEN source.known_receipt THEN
      CASE WHEN source.raw_record_id IS NOT NULL
        THEN public.raw_source_linked_stored_field_candidate_v1(
          source.field,source.raw_payload
        )
        ELSE public.raw_source_current_stored_field_candidate_v1(
          source.field,source.provider_key,source.canonical_attributes
        )
      END
      ELSE NULL
    END AS recovery_candidate
  FROM source_rows AS source
), hashed AS MATERIALIZED (
  SELECT normalized.*,
    CASE WHEN normalized.recovery_candidate IS NOT NULL THEN
      encode(digest(public.raw_source_canonical_json_v1(
        normalized.recovery_candidate
      ),'sha256'),'hex')
      ELSE NULL
    END AS recovery_candidate_hash
  FROM normalized
), decisions AS MATERIALIZED (
  SELECT hashed.*,
    (
      hashed.known_receipt
      AND hashed.recovery_candidate IS NOT NULL
      AND hashed.recovery_candidate_hash=hashed.original_value_hash
    ) AS recoverable,
    CASE
      WHEN hashed.known_receipt
        AND hashed.recovery_candidate IS NOT NULL
        AND hashed.recovery_candidate_hash=hashed.original_value_hash
      THEN hashed.recovery_candidate
      WHEN hashed.known_receipt THEN hashed.value
      ELSE jsonb_build_object(
        '_historicalCleanup','stored-field-evidence-cleanup/v1',
        'reason','UNRECOVERABLE_STORED_FIELD_VALUE_WITHHELD',
        'originalValueHash',hashed.original_value_hash
      )
    END AS target_value,
    CASE
      WHEN hashed.known_receipt
        AND hashed.recovery_candidate IS NOT NULL
        AND hashed.recovery_candidate_hash=hashed.original_value_hash
      THEN 'green' ELSE 'red'
    END AS target_class,
    CASE
      WHEN hashed.known_receipt
        AND hashed.recovery_candidate IS NOT NULL
        AND hashed.recovery_candidate_hash=hashed.original_value_hash
      THEN '["display","match"]'::jsonb ELSE '[]'::jsonb
    END AS target_actions
  FROM hashed
  WHERE hashed.known_receipt
    OR hashed.value IS DISTINCT FROM hashed.direct_sanitized_value
), updated AS (
  UPDATE field_evidence AS evidence
  SET value=decision.target_value,
      data_class=decision.target_class,
      allowed_actions=decision.target_actions
  FROM decisions AS decision
  WHERE evidence.id=decision.id
    AND (
      evidence.value IS DISTINCT FROM decision.target_value
      OR evidence.data_class IS DISTINCT FROM decision.target_class
      OR evidence.allowed_actions IS DISTINCT FROM decision.target_actions
    )
  RETURNING evidence.id
)
INSERT INTO raw_source_field_evidence_cleanup_audit(
  workspace_id,
  field_evidence_id,
  raw_record_id,
  cleanup_contract,
  adapter_version,
  status,
  original_value_hash,
  predecessor_receipt_hash,
  restored_value_hash,
  evidence_fetched_at,
  created_at
)
SELECT decision.workspace_id,
  decision.id,
  decision.raw_record_id,
  'raw-source-stored-field-cleanup/v1',
  'stored-company-field-evidence/v1',
  CASE WHEN decision.recoverable THEN 'RESTORED'
    ELSE 'UNRECOVERABLE_HOLD' END,
  decision.original_value_hash,
  CASE WHEN decision.recoverable THEN decision.current_receipt_hash
    ELSE decision.predecessor_receipt_hash END,
  CASE WHEN decision.recoverable THEN decision.recovery_candidate_hash
    ELSE NULL END,
  decision.fetched_at,
  statement_timestamp()
FROM decisions AS decision
ON CONFLICT (field_evidence_id,cleanup_contract,adapter_version) DO NOTHING;

COMMIT;
