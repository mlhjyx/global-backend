BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- PERMANENT_RESTRICTION: Raw bytes remain immutable for audit, while this
-- append-only ledger permanently removes unsafe records from application reads
-- and every future downstream identity/evidence write.
CREATE TABLE "raw_source_governance_disposition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "raw_record_id" UUID NOT NULL,
  "run_id" UUID,
  "provider_key" VARCHAR(128) NOT NULL,
  "effect" VARCHAR(64) NOT NULL,
  "reason_code" VARCHAR(128) NOT NULL,
  "detected_fields" JSONB NOT NULL,
  "raw_payload_hash" CHAR(64) NOT NULL,
  "raw_ingest_version" VARCHAR(64) NOT NULL,
  "raw_created_at" TIMESTAMP(3) NOT NULL,
  "actor" VARCHAR(128) NOT NULL,
  "governance_version" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "raw_source_governance_disposition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "raw_source_governance_disposition_effect_check"
    CHECK ("effect" = 'RESTRICT_PROCESSING'),
  CONSTRAINT "raw_source_governance_disposition_detected_fields_check"
    CHECK (
      "detected_fields" = '["recipient_name"]'::jsonb OR
      "detected_fields" = '["description"]'::jsonb OR
      "detected_fields" = '["recipient_name", "description"]'::jsonb
    ),
  CONSTRAINT "raw_source_governance_disposition_payload_hash_check"
    CHECK ("raw_payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "raw_source_governance_disposition_raw_scope_fkey"
    FOREIGN KEY ("workspace_id", "raw_record_id")
    REFERENCES "raw_source_record"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "raw_source_governance_disposition_unique_decision"
  ON "raw_source_governance_disposition"
    ("raw_record_id", "effect", "reason_code", "governance_version");
CREATE INDEX "raw_source_governance_disposition_workspace_run_effect_idx"
  ON "raw_source_governance_disposition"("workspace_id", "run_id", "effect");
CREATE INDEX "raw_source_governance_disposition_workspace_created_idx"
  ON "raw_source_governance_disposition"("workspace_id", "created_at");

CREATE FUNCTION "validate_raw_source_governance_disposition_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_row RECORD;
BEGIN
  SELECT
    raw."run_id",
    raw."provider_key",
    raw."payload_hash",
    raw."ingest_version",
    raw."created_at"
  INTO source_row
  FROM public."raw_source_record" AS raw
  WHERE raw."workspace_id" = NEW."workspace_id"
    AND raw."id" = NEW."raw_record_id"
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'raw source governance disposition has no matching Raw record';
  END IF;

  IF source_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR source_row."provider_key" IS DISTINCT FROM NEW."provider_key"
    OR source_row."payload_hash" IS DISTINCT FROM NEW."raw_payload_hash"
    OR source_row."ingest_version" IS DISTINCT FROM NEW."raw_ingest_version"
    OR source_row."created_at" IS DISTINCT FROM NEW."raw_created_at"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'raw source governance disposition provenance snapshot mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "raw_source_governance_disposition_snapshot_guard"
BEFORE INSERT ON "raw_source_governance_disposition"
FOR EACH ROW
EXECUTE FUNCTION "validate_raw_source_governance_disposition_snapshot"();

CREATE FUNCTION "reject_raw_source_governance_disposition_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'raw source governance dispositions are permanent and append-only';
END;
$$;

CREATE TRIGGER "raw_source_governance_disposition_immutable"
BEFORE UPDATE OR DELETE ON "raw_source_governance_disposition"
FOR EACH ROW
EXECUTE FUNCTION "reject_raw_source_governance_disposition_mutation"();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."raw_source_record" AS raw
    CROSS JOIN LATERAL (
      SELECT raw."payload" #> '{attributes,procurement}' AS value
    ) AS procurement
    WHERE raw."provider_key" = 'usaspending_awards'
      AND raw."ingest_status" = 'ACCEPTED'
      AND jsonb_typeof(procurement.value) = 'object'
      AND (
        procurement.value ? 'recipient_name' OR
        procurement.value ? 'description'
      )
      AND (
        raw."payload_hash" IS NULL OR
        raw."payload_hash" !~ '^[0-9a-f]{64}$'
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'historical USAspending restriction requires an existing valid Raw payload hash';
  END IF;
END;
$$;

INSERT INTO "raw_source_governance_disposition" (
  "workspace_id",
  "raw_record_id",
  "run_id",
  "provider_key",
  "effect",
  "reason_code",
  "detected_fields",
  "raw_payload_hash",
  "raw_ingest_version",
  "raw_created_at",
  "actor",
  "governance_version"
)
SELECT
  raw."workspace_id",
  raw."id",
  raw."run_id",
  raw."provider_key",
  'RESTRICT_PROCESSING',
  'HISTORICAL_USASPENDING_PERSONAL_DATA_FIELDS',
  to_jsonb(array_remove(ARRAY[
    CASE WHEN procurement.value ? 'recipient_name' THEN 'recipient_name' END,
    CASE WHEN procurement.value ? 'description' THEN 'description' END
  ]::text[], NULL)),
  raw."payload_hash",
  raw."ingest_version",
  raw."created_at",
  'migration:20260814120000',
  'raw-governance/usaspending-v1'
FROM public."raw_source_record" AS raw
CROSS JOIN LATERAL (
  SELECT raw."payload" #> '{attributes,procurement}' AS value
) AS procurement
WHERE raw."provider_key" = 'usaspending_awards'
  AND raw."ingest_status" = 'ACCEPTED'
  AND jsonb_typeof(procurement.value) = 'object'
  AND (
    procurement.value ? 'recipient_name' OR
    procurement.value ? 'description'
  )
ON CONFLICT (
  "raw_record_id",
  "effect",
  "reason_code",
  "governance_version"
) DO NOTHING;

ALTER TABLE "raw_source_governance_disposition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raw_source_governance_disposition" FORCE ROW LEVEL SECURITY;
CREATE POLICY "raw_source_governance_disposition_tenant_isolation"
  ON "raw_source_governance_disposition"
  FOR SELECT
  USING ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "raw_source_governance_disposition" FROM app_user;
GRANT SELECT ON TABLE "raw_source_governance_disposition" TO app_user;

CREATE POLICY "raw_source_record_governance_restriction"
  ON "raw_source_record" AS RESTRICTIVE
  FOR SELECT
  USING (
    NOT EXISTS (
      SELECT 1
      FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "raw_source_record"."workspace_id"
        AND disposition."raw_record_id" = "raw_source_record"."id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  );

CREATE POLICY "identity_link_governance_restriction"
  ON "identity_link" AS RESTRICTIVE
  FOR ALL
  USING (
    NOT EXISTS (
      SELECT 1 FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "identity_link"."workspace_id"
        AND disposition."raw_record_id" = "identity_link"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  )
  WITH CHECK (
    NOT EXISTS (
      SELECT 1 FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "identity_link"."workspace_id"
        AND disposition."raw_record_id" = "identity_link"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  );

CREATE POLICY "field_evidence_governance_restriction"
  ON "field_evidence" AS RESTRICTIVE
  FOR ALL
  USING (
    "raw_record_id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "field_evidence"."workspace_id"
        AND disposition."raw_record_id" = "field_evidence"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  )
  WITH CHECK (
    "raw_record_id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "field_evidence"."workspace_id"
        AND disposition."raw_record_id" = "field_evidence"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  );

CREATE POLICY "organization_identifier_governance_restriction"
  ON "organization_identifier" AS RESTRICTIVE
  FOR ALL
  USING (
    "raw_record_id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "organization_identifier"."workspace_id"
        AND disposition."raw_record_id" = "organization_identifier"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  )
  WITH CHECK (
    "raw_record_id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "organization_identifier"."workspace_id"
        AND disposition."raw_record_id" = "organization_identifier"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  );

CREATE POLICY "organization_identity_conflict_governance_restriction"
  ON "organization_identity_conflict" AS RESTRICTIVE
  FOR ALL
  USING (
    "raw_record_id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "organization_identity_conflict"."workspace_id"
        AND disposition."raw_record_id" = "organization_identity_conflict"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  )
  WITH CHECK (
    "raw_record_id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "organization_identity_conflict"."workspace_id"
        AND disposition."raw_record_id" = "organization_identity_conflict"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  );

CREATE FUNCTION "reject_governance_restricted_raw_consumption"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."raw_record_id" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public."raw_source_governance_disposition" AS disposition
    WHERE disposition."workspace_id" = NEW."workspace_id"
      AND disposition."raw_record_id" = NEW."raw_record_id"
      AND disposition."effect" = 'RESTRICT_PROCESSING'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'raw source is permanently restricted from downstream processing';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "validate_raw_source_governance_disposition_snapshot"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "reject_raw_source_governance_disposition_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "reject_governance_restricted_raw_consumption"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reject_governance_restricted_raw_consumption"() TO app_user;

CREATE TRIGGER "identity_link_restricted_raw_guard"
BEFORE INSERT OR UPDATE ON "identity_link"
FOR EACH ROW EXECUTE FUNCTION "reject_governance_restricted_raw_consumption"();

CREATE TRIGGER "field_evidence_restricted_raw_guard"
BEFORE INSERT OR UPDATE ON "field_evidence"
FOR EACH ROW EXECUTE FUNCTION "reject_governance_restricted_raw_consumption"();

CREATE TRIGGER "organization_identifier_restricted_raw_guard"
BEFORE INSERT OR UPDATE ON "organization_identifier"
FOR EACH ROW EXECUTE FUNCTION "reject_governance_restricted_raw_consumption"();

CREATE TRIGGER "organization_identity_conflict_restricted_raw_guard"
BEFORE INSERT OR UPDATE ON "organization_identity_conflict"
FOR EACH ROW EXECUTE FUNCTION "reject_governance_restricted_raw_consumption"();

COMMIT;
