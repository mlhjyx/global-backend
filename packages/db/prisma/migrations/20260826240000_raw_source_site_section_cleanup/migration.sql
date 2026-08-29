-- Minimize historical stored site-section keys under the 2300 closed contract.
-- This migration is DML-only, preserves restrictive evidence and provenance,
-- and never attributes current Canonical state to an evidence row linked to Raw.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

WITH source_rows AS MATERIALIZED (
  SELECT evidence.id,
    evidence.workspace_id,
    evidence.value,
    evidence.provider_key,
    evidence.raw_record_id,
    evidence.allowed_actions,
    evidence.data_class,
    evidence.fetched_at,
    company.attributes AS canonical_attributes,
    raw.provider_key AS raw_provider_key,
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
    AND evidence.field='structured_harvest.site_sections'
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
        AND audit.cleanup_contract='raw-source-site-section-cleanup/v1'
        AND audit.adapter_version='structured-harvest-site-sections/v1'
    )
), normalized AS MATERIALIZED (
  SELECT source.*,
    CASE WHEN source.known_receipt
      THEN source.value->>'originalValueHash'
      ELSE encode(digest(
        public.raw_source_canonical_json_v1(source.value),'sha256'
      ),'hex')
    END AS original_value_hash,
    CASE WHEN source.known_receipt THEN encode(digest(
      public.raw_source_canonical_json_v1(source.value),'sha256'
    ),'hex') ELSE NULL END AS predecessor_receipt_hash,
    public.raw_source_sanitize_site_sections_v1(source.value)
      AS direct_sanitized_value,
    CASE WHEN source.known_receipt THEN
      CASE WHEN source.raw_record_id IS NOT NULL
        THEN public.raw_source_linked_site_sections_candidate_v1(
          source.raw_provider_key,source.raw_payload
        )
        ELSE public.raw_source_current_site_sections_candidate_v1(
          source.provider_key,source.canonical_attributes
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
      ELSE jsonb_build_object(
        '_historicalCleanup',
          'structured-harvest-site-section-cleanup/v1',
        'reason','UNSAFE_SITE_SECTION_KEY_WITHHELD',
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
  'raw-source-site-section-cleanup/v1',
  'structured-harvest-site-sections/v1',
  CASE WHEN decision.recoverable THEN 'RESTORED'
    ELSE 'UNRECOVERABLE_HOLD' END,
  decision.original_value_hash,
  decision.predecessor_receipt_hash,
  CASE WHEN decision.recoverable THEN decision.recovery_candidate_hash
    ELSE NULL END,
  decision.fetched_at,
  statement_timestamp()
FROM decisions AS decision
ON CONFLICT (field_evidence_id,cleanup_contract,adapter_version) DO NOTHING;

COMMIT;
