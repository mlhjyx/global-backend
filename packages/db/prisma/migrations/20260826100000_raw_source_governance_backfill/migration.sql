-- Historical data is reconciled only after the additive Raw schema exists.
-- Raw payload bytes are never rewritten or deleted.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;
SET LOCAL app.raw_source_governance_backfill = '20260826100000';

LOCK TABLE "source_fetch", "source_entity", "raw_source_record",
  "identity_link", "field_evidence", "raw_source_governance_disposition"
  IN SHARE ROW EXCLUSIVE MODE;

-- A legacy SourceEntity is bound only when one completed parser-versioned
-- fetch from the same source has the exact persisted observation timestamp.
WITH uniquely_provable AS (
  SELECT entity."id" AS entity_id,
    min(observed_fetch."id"::text)::UUID AS fetch_id
  FROM "source_entity" AS entity
  JOIN "source_fetch" AS observed_fetch
    ON observed_fetch."source_id" = entity."source_id"
   AND observed_fetch."finished_at" = entity."last_seen_at"
   AND observed_fetch."status" IN ('DONE', 'PARTIAL')
   AND observed_fetch."parser_version" IS NOT NULL
  WHERE entity."last_seen_fetch_id" IS NULL
  GROUP BY entity."id"
  HAVING count(*) = 1
)
UPDATE "source_entity" AS entity
SET "last_seen_fetch_id" = proof.fetch_id
FROM uniquely_provable AS proof
WHERE entity."id" = proof.entity_id;

-- Existing current-main projections may have stored SourceEntity.id in the
-- unguarded raw_record_id column. Fail closed for every other unknown UUID.
DO $$
BEGIN
  IF EXISTS (
    WITH referenced AS (
      SELECT "workspace_id", "raw_record_id" FROM "identity_link"
      UNION
      SELECT "workspace_id", "raw_record_id" FROM "field_evidence"
      WHERE "raw_record_id" IS NOT NULL
    )
    SELECT 1
    FROM referenced AS reference
    LEFT JOIN "raw_source_record" AS raw
      ON raw."workspace_id" = reference."workspace_id"
     AND raw."id" = reference."raw_record_id"
    LEFT JOIN "source_entity" AS entity
      ON entity."id" = reference."raw_record_id"
    WHERE raw."id" IS NULL AND entity."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'downstream raw reference is neither RawSourceRecord nor SourceEntity'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    WITH referenced AS (
      SELECT "workspace_id", "raw_record_id" FROM "identity_link"
      UNION
      SELECT "workspace_id", "raw_record_id" FROM "field_evidence"
      WHERE "raw_record_id" IS NOT NULL
    )
    SELECT 1
    FROM referenced AS reference
    JOIN "source_entity" AS entity ON entity."id" = reference."raw_record_id"
    JOIN "monitored_source" AS source ON source."id" = entity."source_id"
    LEFT JOIN "raw_source_record" AS raw
      ON raw."workspace_id" = reference."workspace_id"
     AND raw."id" = reference."raw_record_id"
    WHERE raw."id" IS NULL
      AND source."provider_key" NOT IN ('trade_fair', 'mapyourshow')
  ) THEN
    RAISE EXCEPTION 'legacy monitored Raw reference has no governed provider profile'
      USING ERRCODE = '23514';
  END IF;
END
$$;

WITH referenced AS (
  SELECT "workspace_id", "raw_record_id" AS source_entity_id
  FROM "identity_link"
  UNION
  SELECT "workspace_id", "raw_record_id" AS source_entity_id
  FROM "field_evidence"
  WHERE "raw_record_id" IS NOT NULL
), legacy_origins AS (
  SELECT reference."workspace_id", entity."id" AS source_entity_id,
    source."id" AS source_id, source."source_key", source."provider_key",
    jsonb_build_object(
      '_rawReceipt', 'raw-source/legacy-monitored-reference/v1',
      'provenanceLevel', 'legacy_reference_only',
      'originKind', 'monitored_source_projection',
      'sourceEntityId', entity."id",
      'sourceId', source."id"
    ) AS receipt
  FROM referenced AS reference
  JOIN "source_entity" AS entity ON entity."id" = reference.source_entity_id
  JOIN "monitored_source" AS source ON source."id" = entity."source_id"
  LEFT JOIN "raw_source_record" AS current_raw
    ON current_raw."workspace_id" = reference."workspace_id"
   AND current_raw."id" = reference.source_entity_id
  WHERE current_raw."id" IS NULL
    AND source."provider_key" IN ('trade_fair', 'mapyourshow')
)
INSERT INTO "raw_source_record" (
  "id", "workspace_id", "run_id", "source_entity_id", "provider_key",
  "source_class", "external_id", "payload", "source_url", "fetched_at",
  "content_hash", "parser_version", "cost_cents", "ingest_key",
  "payload_hash", "payload_bytes", "ingest_version", "ingest_status",
  "disposition_code", "retention_days", "expires_at", "expired_at",
  "source_policy_snapshot", "created_at"
)
SELECT gen_random_uuid(), origin."workspace_id", NULL,
  origin.source_entity_id, 'trade_fair', 'industry_data', NULL,
  origin.receipt, NULL, NULL, NULL, NULL, 0,
  'legacy-source-entity:' || origin.source_entity_id::text,
  encode(public.digest(origin.receipt::text, 'sha256'), 'hex'),
  octet_length(origin.receipt::text),
  'raw-source/legacy-reference/v1', 'QUARANTINED',
  'LEGACY_SOURCE_ENTITY_REFERENCE', NULL, NULL, NULL,
  jsonb_build_object(
    'kind', 'legacy_reference_only',
    'provenanceLevel', 'legacy_reference_only',
    'originProviderKey', origin."provider_key",
    'sourceKey', origin."source_key"
  ),
  CURRENT_TIMESTAMP
FROM legacy_origins AS origin
ON CONFLICT ON CONSTRAINT
  "raw_source_record_workspace_source_entity_ingest_key" DO NOTHING;

UPDATE "identity_link" AS link
SET "raw_record_id" = raw."id"
FROM "raw_source_record" AS raw
WHERE raw."workspace_id" = link."workspace_id"
  AND raw."source_entity_id" = link."raw_record_id"
  AND raw."ingest_version" = 'raw-source/legacy-reference/v1';

UPDATE "field_evidence" AS evidence
SET "raw_record_id" = raw."id"
FROM "raw_source_record" AS raw
WHERE evidence."raw_record_id" IS NOT NULL
  AND raw."workspace_id" = evidence."workspace_id"
  AND raw."source_entity_id" = evidence."raw_record_id"
  AND raw."ingest_version" = 'raw-source/legacy-reference/v1';

-- The only legacy Raw mutation is a derived SHA-256/byte-count fill for exact
-- unsafe rows. The payload and every origin/provenance value remain unchanged.
UPDATE "raw_source_record" AS raw
SET "payload_hash" = encode(
      public.digest(raw."payload"::text, 'sha256'), 'hex'
    ),
    "payload_bytes" = octet_length(raw."payload"::text)
WHERE raw."provider_key" = 'usaspending_awards'
  AND raw."ingest_status" = 'ACCEPTED'
  AND raw."payload_hash" IS NULL
  AND raw."payload_bytes" IS NULL
  AND jsonb_typeof(raw."payload" #> '{attributes,procurement}') = 'object'
  AND (
    raw."payload" #> '{attributes,procurement}' ? 'recipient_name'
    OR raw."payload" #> '{attributes,procurement}' ? 'description'
  );

INSERT INTO "raw_source_governance_disposition" (
  "workspace_id", "raw_record_id", "run_id", "source_entity_id",
  "provider_key", "effect", "reason_code", "detected_fields",
  "raw_payload_hash", "raw_ingest_version", "raw_created_at", "actor",
  "governance_version"
)
SELECT raw."workspace_id", raw."id", raw."run_id", raw."source_entity_id",
  raw."provider_key", 'RESTRICT_PROCESSING',
  'HISTORICAL_USASPENDING_PERSONAL_DATA_FIELDS',
  CASE
    WHEN procurement.value ? 'recipient_name'
      AND procurement.value ? 'description'
      THEN '["recipient_name", "description"]'::jsonb
    WHEN procurement.value ? 'recipient_name'
      THEN '["recipient_name"]'::jsonb
    ELSE '["description"]'::jsonb
  END,
  raw."payload_hash", raw."ingest_version", raw."created_at",
  'migration:20260826100000', 'raw-governance/usaspending-v2'
FROM "raw_source_record" AS raw
CROSS JOIN LATERAL (
  SELECT raw."payload" #> '{attributes,procurement}' AS value
) AS procurement
WHERE raw."provider_key" = 'usaspending_awards'
  AND raw."ingest_status" = 'ACCEPTED'
  AND jsonb_typeof(procurement.value) = 'object'
  AND (
    procurement.value ? 'recipient_name'
    OR procurement.value ? 'description'
  )
ON CONFLICT (
  "raw_record_id", "effect", "reason_code", "governance_version"
) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "raw_source_record" AS raw
    WHERE raw."provider_key" = 'usaspending_awards'
      AND raw."ingest_status" = 'ACCEPTED'
      AND jsonb_typeof(raw."payload" #> '{attributes,procurement}') = 'object'
      AND (
        raw."payload" #> '{attributes,procurement}' ? 'recipient_name'
        OR raw."payload" #> '{attributes,procurement}' ? 'description'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "raw_source_governance_disposition" AS disposition
        WHERE disposition."workspace_id" = raw."workspace_id"
          AND disposition."raw_record_id" = raw."id"
          AND disposition."effect" = 'RESTRICT_PROCESSING'
      )
  ) THEN
    RAISE EXCEPTION 'historical restricted Raw row has no durable disposition'
      USING ERRCODE = '23514';
  END IF;
END
$$;

ALTER TABLE "raw_source_record"
  VALIDATE CONSTRAINT "raw_source_record_exactly_one_origin_check";
ALTER TABLE "raw_source_record"
  VALIDATE CONSTRAINT "raw_source_record_ingest_status_check";
ALTER TABLE "raw_source_record"
  VALIDATE CONSTRAINT "raw_source_record_v2_receipt_check";
ALTER TABLE "raw_source_record"
  VALIDATE CONSTRAINT "raw_source_record_source_entity_id_fkey";
ALTER TABLE "raw_source_record"
  VALIDATE CONSTRAINT "raw_source_record_workspace_run_fkey";
ALTER TABLE "source_entity"
  VALIDATE CONSTRAINT "source_entity_last_seen_fetch_id_fkey";
ALTER TABLE "source_entity"
  VALIDATE CONSTRAINT "source_entity_last_seen_fetch_fkey";
ALTER TABLE "identity_link"
  VALIDATE CONSTRAINT "identity_link_workspace_raw_fkey";
ALTER TABLE "field_evidence"
  VALIDATE CONSTRAINT "field_evidence_workspace_raw_fkey";

COMMIT;
