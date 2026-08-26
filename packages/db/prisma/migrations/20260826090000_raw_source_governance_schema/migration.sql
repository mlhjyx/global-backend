-- Raw Source successor schema. Forward-only from current main; no historical
-- PR #407 migration directory or checksum is reused.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

ALTER TABLE "raw_source_record"
  ALTER COLUMN "run_id" DROP NOT NULL,
  ADD COLUMN "source_entity_id" UUID,
  ADD COLUMN "ingest_key" TEXT,
  ADD COLUMN "payload_hash" CHAR(64),
  ADD COLUMN "payload_bytes" INTEGER,
  ADD COLUMN "ingest_version" VARCHAR(64) NOT NULL DEFAULT 'raw-source/v1',
  ADD COLUMN "ingest_status" VARCHAR(32) NOT NULL DEFAULT 'ACCEPTED',
  ADD COLUMN "disposition_code" VARCHAR(128),
  ADD COLUMN "retention_days" INTEGER,
  ADD COLUMN "expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "expired_at" TIMESTAMPTZ(3),
  ADD COLUMN "source_policy_snapshot" JSONB;

ALTER TABLE "source_entity"
  ADD COLUMN "last_seen_fetch_id" UUID;

ALTER TABLE "discovery_run"
  ADD CONSTRAINT "discovery_run_workspace_id_id_key"
    UNIQUE ("workspace_id", "id");
ALTER TABLE "raw_source_record"
  ADD CONSTRAINT "raw_source_record_workspace_id_id_key"
    UNIQUE ("workspace_id", "id"),
  ADD CONSTRAINT "raw_source_record_workspace_source_entity_ingest_key"
    UNIQUE ("workspace_id", "source_entity_id", "ingest_key");
ALTER TABLE "source_fetch"
  ADD CONSTRAINT "source_fetch_id_source_id_key" UNIQUE ("id", "source_id");
ALTER TABLE "field_evidence"
  ADD CONSTRAINT "field_evidence_raw_field_unique"
    UNIQUE ("workspace_id", "entity_type", "entity_id", "field", "raw_record_id");

CREATE UNIQUE INDEX "raw_source_record_run_provider_ingest_key_key"
  ON "raw_source_record"("run_id", "provider_key", "ingest_key")
  WHERE "run_id" IS NOT NULL AND "ingest_key" IS NOT NULL;
CREATE INDEX "raw_source_record_workspace_status_expires_idx"
  ON "raw_source_record"("workspace_id", "ingest_status", "expires_at");
CREATE INDEX "source_entity_last_seen_fetch_idx"
  ON "source_entity"("last_seen_fetch_id");

ALTER TABLE "raw_source_record"
  ADD CONSTRAINT "raw_source_record_exactly_one_origin_check" CHECK (
    ("run_id" IS NOT NULL AND "source_entity_id" IS NULL)
    OR ("run_id" IS NULL AND "source_entity_id" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "raw_source_record_ingest_status_check" CHECK (
    "ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED', 'EXPIRED')
  ) NOT VALID,
  ADD CONSTRAINT "raw_source_record_v2_receipt_check" CHECK (
    "ingest_version" <> 'raw-source/v2'
    OR (
      "ingest_key" IS NOT NULL
      AND char_length("ingest_key") BETWEEN 1 AND 512
      AND "payload_hash" ~ '^[0-9a-f]{64}$'
      AND "payload_bytes" BETWEEN 1 AND 2147483647
      AND "retention_days" BETWEEN 1 AND 3650
      AND "expires_at" IS NOT NULL
      AND jsonb_typeof("source_policy_snapshot") = 'object'
      AND (
        (
          "ingest_status" = 'ACCEPTED'
          AND "disposition_code" IS NULL
          AND "expired_at" IS NULL
          AND "source_url" IS NOT NULL
          AND "fetched_at" IS NOT NULL
          AND "content_hash" IS NOT NULL
          AND "parser_version" IS NOT NULL
        )
        OR (
          "ingest_status" IN ('QUARANTINED', 'REJECTED')
          AND "disposition_code" IS NOT NULL
          AND "expired_at" IS NULL
        )
        OR (
          "ingest_status" = 'EXPIRED'
          AND "expired_at" IS NOT NULL
          AND jsonb_typeof("payload") = 'object'
          AND "payload" ->> '_rawReceipt' = 'raw-source/expired/v1'
          AND "payload" ->> 'payloadHash' = "payload_hash"
          AND "payload" -> 'payloadBytes' = to_jsonb("payload_bytes")
          AND "payload" ->> 'previousStatus' IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
          AND "payload" - ARRAY[
            '_rawReceipt', 'previousStatus', 'payloadHash', 'payloadBytes'
          ] = '{}'::jsonb
        )
      )
    )
  ) NOT VALID;

ALTER TABLE "raw_source_record"
  ADD CONSTRAINT "raw_source_record_source_entity_id_fkey"
    FOREIGN KEY ("source_entity_id") REFERENCES "source_entity"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID,
  ADD CONSTRAINT "raw_source_record_workspace_run_fkey"
    FOREIGN KEY ("workspace_id", "run_id")
    REFERENCES "discovery_run"("workspace_id", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "source_entity"
  ADD CONSTRAINT "source_entity_last_seen_fetch_id_fkey"
    FOREIGN KEY ("last_seen_fetch_id") REFERENCES "source_fetch"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID,
  ADD CONSTRAINT "source_entity_last_seen_fetch_fkey"
    FOREIGN KEY ("last_seen_fetch_id", "source_id")
    REFERENCES "source_fetch"("id", "source_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "identity_link"
  ADD CONSTRAINT "identity_link_workspace_raw_fkey"
    FOREIGN KEY ("workspace_id", "raw_record_id")
    REFERENCES "raw_source_record"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "field_evidence"
  ADD CONSTRAINT "field_evidence_workspace_raw_fkey"
    FOREIGN KEY ("workspace_id", "raw_record_id")
    REFERENCES "raw_source_record"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;

CREATE TABLE "raw_source_governance_disposition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "raw_record_id" UUID NOT NULL,
  "run_id" UUID,
  "source_entity_id" UUID,
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
  CONSTRAINT "raw_source_governance_disposition_detected_fields_check" CHECK (
    "detected_fields" = '["recipient_name"]'::jsonb
    OR "detected_fields" = '["description"]'::jsonb
    OR "detected_fields" = '["recipient_name", "description"]'::jsonb
  ),
  CONSTRAINT "raw_source_governance_disposition_payload_hash_check"
    CHECK ("raw_payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "raw_source_governance_disposition_raw_record_id_fkey"
    FOREIGN KEY ("raw_record_id") REFERENCES "raw_source_record"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "raw_source_governance_disposition_raw_scope_fkey"
    FOREIGN KEY ("workspace_id", "raw_record_id")
    REFERENCES "raw_source_record"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "raw_source_governance_disposition_unique_decision"
  ON "raw_source_governance_disposition"(
    "raw_record_id", "effect", "reason_code", "governance_version"
  );
CREATE INDEX "raw_source_governance_disposition_workspace_run_effect_idx"
  ON "raw_source_governance_disposition"("workspace_id", "run_id", "effect");
CREATE INDEX "raw_source_governance_disposition_workspace_created_idx"
  ON "raw_source_governance_disposition"("workspace_id", "created_at");

ALTER TABLE "raw_source_governance_disposition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raw_source_governance_disposition" FORCE ROW LEVEL SECURITY;
CREATE POLICY "raw_source_governance_disposition_tenant_isolation"
  ON "raw_source_governance_disposition"
  FOR SELECT
  USING ("workspace_id" = current_workspace_id());

CREATE POLICY "raw_source_record_governance_restriction"
  ON "raw_source_record" AS RESTRICTIVE
  FOR ALL
  USING (NOT EXISTS (
    SELECT 1
    FROM "raw_source_governance_disposition" AS disposition
    WHERE disposition."workspace_id" = "raw_source_record"."workspace_id"
      AND disposition."raw_record_id" = "raw_source_record"."id"
      AND disposition."effect" = 'RESTRICT_PROCESSING'
  ))
  WITH CHECK (NOT EXISTS (
    SELECT 1
    FROM "raw_source_governance_disposition" AS disposition
    WHERE disposition."workspace_id" = "raw_source_record"."workspace_id"
      AND disposition."raw_record_id" = "raw_source_record"."id"
      AND disposition."effect" = 'RESTRICT_PROCESSING'
  ));
CREATE POLICY "identity_link_governance_restriction"
  ON "identity_link" AS RESTRICTIVE
  FOR ALL
  USING (NOT EXISTS (
    SELECT 1
    FROM "raw_source_governance_disposition" AS disposition
    WHERE disposition."workspace_id" = "identity_link"."workspace_id"
      AND disposition."raw_record_id" = "identity_link"."raw_record_id"
      AND disposition."effect" = 'RESTRICT_PROCESSING'
  ))
  WITH CHECK (NOT EXISTS (
    SELECT 1
    FROM "raw_source_governance_disposition" AS disposition
    WHERE disposition."workspace_id" = "identity_link"."workspace_id"
      AND disposition."raw_record_id" = "identity_link"."raw_record_id"
      AND disposition."effect" = 'RESTRICT_PROCESSING'
  ));
CREATE POLICY "field_evidence_governance_restriction"
  ON "field_evidence" AS RESTRICTIVE
  FOR ALL
  USING (
    "raw_record_id" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "field_evidence"."workspace_id"
        AND disposition."raw_record_id" = "field_evidence"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  )
  WITH CHECK (
    "raw_record_id" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM "raw_source_governance_disposition" AS disposition
      WHERE disposition."workspace_id" = "field_evidence"."workspace_id"
        AND disposition."raw_record_id" = "field_evidence"."raw_record_id"
        AND disposition."effect" = 'RESTRICT_PROCESSING'
    )
  );

CREATE FUNCTION enforce_raw_source_record_immutability_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."ingest_version" <> 'raw-source/v2'
    AND session_user = 'global'
    AND current_setting('app.raw_source_governance_backfill', true)
      = '20260826100000'
    AND OLD."payload_hash" IS NULL
    AND NEW."payload_hash" = encode(
      public.digest(OLD."payload"::text, 'sha256'), 'hex'
    )
    AND OLD."payload_bytes" IS NULL
    AND NEW."payload_bytes" = octet_length(OLD."payload"::text)
    AND NEW."id" IS NOT DISTINCT FROM OLD."id"
    AND NEW."workspace_id" IS NOT DISTINCT FROM OLD."workspace_id"
    AND NEW."run_id" IS NOT DISTINCT FROM OLD."run_id"
    AND NEW."source_entity_id" IS NOT DISTINCT FROM OLD."source_entity_id"
    AND NEW."provider_key" IS NOT DISTINCT FROM OLD."provider_key"
    AND NEW."source_class" IS NOT DISTINCT FROM OLD."source_class"
    AND NEW."external_id" IS NOT DISTINCT FROM OLD."external_id"
    AND NEW."payload" IS NOT DISTINCT FROM OLD."payload"
    AND NEW."source_url" IS NOT DISTINCT FROM OLD."source_url"
    AND NEW."fetched_at" IS NOT DISTINCT FROM OLD."fetched_at"
    AND NEW."content_hash" IS NOT DISTINCT FROM OLD."content_hash"
    AND NEW."parser_version" IS NOT DISTINCT FROM OLD."parser_version"
    AND NEW."cost_cents" IS NOT DISTINCT FROM OLD."cost_cents"
    AND NEW."ingest_key" IS NOT DISTINCT FROM OLD."ingest_key"
    AND NEW."ingest_version" IS NOT DISTINCT FROM OLD."ingest_version"
    AND NEW."ingest_status" IS NOT DISTINCT FROM OLD."ingest_status"
    AND NEW."disposition_code" IS NOT DISTINCT FROM OLD."disposition_code"
    AND NEW."retention_days" IS NOT DISTINCT FROM OLD."retention_days"
    AND NEW."expires_at" IS NOT DISTINCT FROM OLD."expires_at"
    AND NEW."expired_at" IS NOT DISTINCT FROM OLD."expired_at"
    AND NEW."source_policy_snapshot" IS NOT DISTINCT FROM OLD."source_policy_snapshot"
    AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
  THEN
    RETURN NEW;
  END IF;

  IF OLD."ingest_version" = 'raw-source/v2'
    AND OLD."ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
    AND NEW."ingest_status" = 'EXPIRED'
    AND NEW."expired_at" IS NOT NULL
    AND NEW."payload" = jsonb_build_object(
      '_rawReceipt', 'raw-source/expired/v1',
      'previousStatus', OLD."ingest_status",
      'payloadHash', OLD."payload_hash",
      'payloadBytes', OLD."payload_bytes"
    )
    AND NEW."id" IS NOT DISTINCT FROM OLD."id"
    AND NEW."workspace_id" IS NOT DISTINCT FROM OLD."workspace_id"
    AND NEW."run_id" IS NOT DISTINCT FROM OLD."run_id"
    AND NEW."source_entity_id" IS NOT DISTINCT FROM OLD."source_entity_id"
    AND NEW."provider_key" IS NOT DISTINCT FROM OLD."provider_key"
    AND NEW."source_class" IS NOT DISTINCT FROM OLD."source_class"
    AND NEW."external_id" IS NOT DISTINCT FROM OLD."external_id"
    AND NEW."source_url" IS NOT DISTINCT FROM OLD."source_url"
    AND NEW."fetched_at" IS NOT DISTINCT FROM OLD."fetched_at"
    AND NEW."content_hash" IS NOT DISTINCT FROM OLD."content_hash"
    AND NEW."parser_version" IS NOT DISTINCT FROM OLD."parser_version"
    AND NEW."cost_cents" IS NOT DISTINCT FROM OLD."cost_cents"
    AND NEW."ingest_key" IS NOT DISTINCT FROM OLD."ingest_key"
    AND NEW."payload_hash" IS NOT DISTINCT FROM OLD."payload_hash"
    AND NEW."payload_bytes" IS NOT DISTINCT FROM OLD."payload_bytes"
    AND NEW."ingest_version" IS NOT DISTINCT FROM OLD."ingest_version"
    AND NEW."disposition_code" IS NOT DISTINCT FROM OLD."disposition_code"
    AND NEW."retention_days" IS NOT DISTINCT FROM OLD."retention_days"
    AND NEW."expires_at" IS NOT DISTINCT FROM OLD."expires_at"
    AND NEW."source_policy_snapshot" IS NOT DISTINCT FROM OLD."source_policy_snapshot"
    AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'raw source origin/provenance is immutable; only one-way expiry is allowed'
    USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER "raw_source_record_immutable_guard"
BEFORE UPDATE ON "raw_source_record"
FOR EACH ROW EXECUTE FUNCTION enforce_raw_source_record_immutability_v1();

CREATE FUNCTION reject_raw_source_record_delete_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'raw source physical deletion is forbidden; use one-way expiry'
    USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER "raw_source_record_delete_guard"
BEFORE DELETE ON "raw_source_record"
FOR EACH ROW EXECUTE FUNCTION reject_raw_source_record_delete_v1();

CREATE FUNCTION validate_raw_source_governance_snapshot_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE source_row RECORD;
BEGIN
  SELECT raw."run_id", raw."source_entity_id", raw."provider_key",
    raw."payload_hash", raw."ingest_version", raw."created_at"
  INTO source_row
  FROM public."raw_source_record" AS raw
  WHERE raw."workspace_id" = NEW."workspace_id"
    AND raw."id" = NEW."raw_record_id"
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'raw source governance snapshot has no matching Raw record'
      USING ERRCODE = '23503';
  END IF;
  IF source_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR source_row."source_entity_id" IS DISTINCT FROM NEW."source_entity_id"
    OR source_row."provider_key" IS DISTINCT FROM NEW."provider_key"
    OR source_row."payload_hash" IS DISTINCT FROM NEW."raw_payload_hash"
    OR source_row."ingest_version" IS DISTINCT FROM NEW."raw_ingest_version"
    OR source_row."created_at" IS DISTINCT FROM NEW."raw_created_at"
  THEN
    RAISE EXCEPTION 'raw source governance provenance snapshot mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "raw_source_governance_disposition_snapshot_guard"
BEFORE INSERT ON "raw_source_governance_disposition"
FOR EACH ROW EXECUTE FUNCTION validate_raw_source_governance_snapshot_v1();

CREATE FUNCTION reject_raw_source_governance_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'raw source governance dispositions are permanent and append-only'
    USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER "raw_source_governance_disposition_immutable"
BEFORE UPDATE OR DELETE ON "raw_source_governance_disposition"
FOR EACH ROW EXECUTE FUNCTION reject_raw_source_governance_mutation_v1();

CREATE FUNCTION reject_restricted_raw_consumption_v1()
RETURNS TRIGGER
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
    RAISE EXCEPTION 'raw source is permanently restricted from downstream processing'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "identity_link_restricted_raw_guard"
BEFORE INSERT OR UPDATE ON "identity_link"
FOR EACH ROW EXECUTE FUNCTION reject_restricted_raw_consumption_v1();
CREATE TRIGGER "field_evidence_restricted_raw_guard"
BEFORE INSERT OR UPDATE ON "field_evidence"
FOR EACH ROW EXECUTE FUNCTION reject_restricted_raw_consumption_v1();

CREATE FUNCTION list_due_raw_retention_workspaces_v1(
  p_limit INTEGER, p_after_workspace_id UUID DEFAULT NULL
)
RETURNS TABLE(workspace_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_limit NOT BETWEEN 1 AND 501
  THEN
    RAISE EXCEPTION 'RAW_RETENTION_LIST_DENIED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT raw."workspace_id"
  FROM public."raw_source_record" AS raw
  WHERE raw."ingest_version" = 'raw-source/v2'
    AND raw."ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
    AND raw."expires_at" <= statement_timestamp()
    AND (p_after_workspace_id IS NULL OR raw."workspace_id" > p_after_workspace_id)
  ORDER BY raw."workspace_id"
  LIMIT p_limit;
END
$$;

CREATE FUNCTION expire_due_raw_source_records_v1(
  p_workspace_id UUID, p_limit INTEGER, p_now TIMESTAMPTZ
)
RETURNS TABLE(expired INTEGER, deferred_for_conflict INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed INTEGER;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_limit NOT BETWEEN 1 AND 500
    OR p_now IS NULL
  THEN
    RAISE EXCEPTION 'RAW_RETENTION_EXPIRE_DENIED' USING ERRCODE = '42501';
  END IF;
  WITH candidates AS (
    SELECT raw."id"
    FROM public."raw_source_record" AS raw
    WHERE raw."workspace_id" = p_workspace_id
      AND raw."ingest_version" = 'raw-source/v2'
      AND raw."ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
      AND raw."expires_at" <= p_now
    ORDER BY raw."id"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE public."raw_source_record" AS raw
    SET "payload" = jsonb_build_object(
        '_rawReceipt', 'raw-source/expired/v1',
        'previousStatus', raw."ingest_status",
        'payloadHash', raw."payload_hash",
        'payloadBytes', raw."payload_bytes"
      ),
      "ingest_status" = 'EXPIRED',
      "expired_at" = p_now
    FROM candidates
    WHERE raw."id" = candidates."id"
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO changed FROM updated;
  RETURN QUERY SELECT changed, 0;
END
$$;

REVOKE DELETE ON TABLE "raw_source_record" FROM app_user;
REVOKE ALL ON TABLE "raw_source_governance_disposition" FROM PUBLIC, app_user;
GRANT SELECT ON TABLE "raw_source_governance_disposition" TO app_user;
REVOKE ALL ON FUNCTION enforce_raw_source_record_immutability_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_raw_source_record_delete_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_raw_source_governance_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_raw_source_governance_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_restricted_raw_consumption_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_due_raw_retention_workspaces_v1(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_due_raw_source_records_v1(UUID, INTEGER, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_raw_retention_workspaces_v1(INTEGER, UUID) TO app_user;
GRANT EXECUTE ON FUNCTION expire_due_raw_source_records_v1(UUID, INTEGER, TIMESTAMPTZ) TO app_user;

COMMIT;
