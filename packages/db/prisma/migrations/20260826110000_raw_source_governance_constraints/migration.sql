-- Forward-only corrections for Raw Source app insertion, retention authority,
-- and truthful lock-conflict reporting. The committed 0900/1000 bytes remain
-- immutable; 1000's VALIDATE statements are its transactional post-backfill
-- integrity gate.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

ALTER TABLE "raw_source_record"
  ALTER COLUMN "ingest_version" SET DEFAULT 'raw-source/v2';

-- A current v2 observation must be able to supersede a same-key legacy row
-- without making that legacy row consumable. This transactional index rebuild
-- is intentionally retained-deployment scale HOLD pending lock-window review.
DROP INDEX "raw_source_record_run_id_provider_key_external_id_key";
CREATE UNIQUE INDEX "raw_source_record_run_provider_external_ingest_key"
  ON "raw_source_record"(
    "run_id", "provider_key", "external_id", "ingest_version"
  );

CREATE FUNCTION enforce_raw_source_insert_v2_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."ingest_version" IS DISTINCT FROM 'raw-source/v2' THEN
    RAISE EXCEPTION 'RAW_SOURCE_INSERT_V2_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "raw_source_record_insert_v2_guard"
BEFORE INSERT ON "raw_source_record"
FOR EACH ROW EXECUTE FUNCTION enforce_raw_source_insert_v2_v1();

-- Direct app UPDATE is never an expiry authority. The definer function below
-- is the only mutation surface and its trigger-only capability is session,
-- role, and transaction scoped.
REVOKE UPDATE ON TABLE "raw_source_record" FROM app_user;

CREATE OR REPLACE FUNCTION enforce_raw_source_record_immutability_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."ingest_version" = 'raw-source/v2'
    AND OLD."ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
    AND OLD."expires_at" <= statement_timestamp()
    AND NEW."ingest_status" = 'EXPIRED'
    AND NEW."expired_at" IS NOT NULL
    AND NEW."payload" = jsonb_build_object(
      '_rawReceipt', 'raw-source/expired/v1',
      'previousStatus', OLD."ingest_status",
      'payloadHash', OLD."payload_hash",
      'payloadBytes', OLD."payload_bytes"
    )
    AND session_user = 'app_user'
    AND current_user IS DISTINCT FROM session_user
    AND current_setting('role', true) = 'none'
    AND current_setting('app.raw_source_retention_expiry', true)
      = '20260826110000'
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
  RAISE EXCEPTION 'raw source origin/provenance is immutable; expiry requires the retention authority'
    USING ERRCODE = '55000';
END
$$;

REVOKE ALL ON FUNCTION expire_due_raw_source_records_v1(
  UUID, INTEGER, TIMESTAMPTZ
) FROM PUBLIC, app_user;
DROP FUNCTION expire_due_raw_source_records_v1(UUID, INTEGER, TIMESTAMPTZ);

-- p_now remains only for binary/activity compatibility and is deliberately
-- ignored. All due-time decisions and receipts use one DB statement time.
CREATE FUNCTION expire_due_raw_source_records_v1(
  p_workspace_id UUID, p_limit INTEGER, p_now TIMESTAMPTZ
)
RETURNS TABLE(
  expired INTEGER,
  deferred_for_conflict INTEGER,
  has_more BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed INTEGER;
  remaining_due INTEGER;
  authoritative_now TIMESTAMPTZ := statement_timestamp();
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_limit NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'RAW_RETENTION_EXPIRE_DENIED' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config(
    'app.raw_source_retention_expiry', '20260826110000', true
  );
  WITH candidates AS (
    SELECT raw."id"
    FROM public."raw_source_record" AS raw
    WHERE raw."workspace_id" = p_workspace_id
      AND raw."ingest_version" = 'raw-source/v2'
      AND raw."ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
      AND raw."expires_at" <= authoritative_now
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
      "expired_at" = authoritative_now
    FROM candidates
    WHERE raw."id" = candidates."id"
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO changed FROM updated;

  SELECT count(*)::INTEGER INTO remaining_due
  FROM public."raw_source_record" AS raw
  WHERE raw."workspace_id" = p_workspace_id
    AND raw."ingest_version" = 'raw-source/v2'
    AND raw."ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
    AND raw."expires_at" <= authoritative_now;

  RETURN QUERY SELECT
    changed,
    CASE WHEN changed < p_limit THEN remaining_due ELSE 0 END,
    remaining_due > 0;
END
$$;

REVOKE ALL ON FUNCTION enforce_raw_source_insert_v2_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_raw_source_record_immutability_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_due_raw_source_records_v1(
  UUID, INTEGER, TIMESTAMPTZ
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_due_raw_source_records_v1(
  UUID, INTEGER, TIMESTAMPTZ
) TO app_user;

COMMIT;
