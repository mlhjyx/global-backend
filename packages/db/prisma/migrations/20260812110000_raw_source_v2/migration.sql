-- Raw Source v2 is an additive, forward-only receipt layer.
-- Historical rows remain raw-source/v1 and are intentionally not scanned or rewritten.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "raw_source_record"
  ADD COLUMN "ingest_key" TEXT,
  ADD COLUMN "payload_hash" TEXT,
  ADD COLUMN "payload_bytes" INTEGER,
  ADD COLUMN "ingest_version" TEXT NOT NULL DEFAULT 'raw-source/v1',
  ADD COLUMN "ingest_status" TEXT NOT NULL DEFAULT 'ACCEPTED',
  ADD COLUMN "disposition_code" TEXT,
  ADD COLUMN "retention_days" INTEGER,
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "expired_at" TIMESTAMP(3),
  ADD COLUMN "source_policy_snapshot" JSONB;

CREATE UNIQUE INDEX "raw_source_record_run_provider_ingest_key_key"
  ON "raw_source_record"("run_id", "provider_key", "ingest_key")
  WHERE "ingest_key" IS NOT NULL;

CREATE INDEX "raw_source_record_workspace_status_expires_idx"
  ON "raw_source_record"("workspace_id", "ingest_status", "expires_at");

ALTER TABLE "raw_source_record"
  ADD CONSTRAINT "raw_source_record_ingest_status_check"
  CHECK ("ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED', 'EXPIRED')),
  ADD CONSTRAINT "raw_source_record_v2_receipt_check"
  CHECK (
    "ingest_version" <> 'raw-source/v2'
    OR (
      "ingest_key" IS NOT NULL
      AND "payload_hash" ~ '^[0-9a-f]{64}$'
      AND "payload_bytes" IS NOT NULL AND "payload_bytes" > 0
      AND "retention_days" IS NOT NULL AND "retention_days" BETWEEN 1 AND 3650
      AND "expires_at" IS NOT NULL
      AND "source_policy_snapshot" IS NOT NULL
      AND (
        ("ingest_status" = 'ACCEPTED' AND "disposition_code" IS NULL AND "expired_at" IS NULL)
        OR ("ingest_status" IN ('QUARANTINED', 'REJECTED') AND "disposition_code" IS NOT NULL AND "expired_at" IS NULL)
        OR (
          "ingest_status" = 'EXPIRED'
          AND "expired_at" IS NOT NULL
          AND "payload" ->> '_rawReceipt' = 'raw-source/expired-v1'
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION raw_source_record_v2_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."ingest_version" <> 'raw-source/v2' THEN
    RETURN NEW;
  END IF;

  IF OLD."ingest_status" IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
     AND NEW."ingest_status" = 'EXPIRED'
     AND NEW."expired_at" IS NOT NULL
     AND NEW."payload" ->> '_rawReceipt' = 'raw-source/expired-v1'
     AND NEW."id" IS NOT DISTINCT FROM OLD."id"
     AND NEW."workspace_id" IS NOT DISTINCT FROM OLD."workspace_id"
     AND NEW."run_id" IS NOT DISTINCT FROM OLD."run_id"
     AND NEW."provider_key" IS NOT DISTINCT FROM OLD."provider_key"
     AND NEW."source_class" IS NOT DISTINCT FROM OLD."source_class"
     AND NEW."external_id" IS NOT DISTINCT FROM OLD."external_id"
     AND NEW."source_url" IS NOT DISTINCT FROM OLD."source_url"
     AND NEW."fetched_at" IS NOT DISTINCT FROM OLD."fetched_at"
     AND NEW."content_hash" IS NOT DISTINCT FROM OLD."content_hash"
     AND NEW."parser_version" IS NOT DISTINCT FROM OLD."parser_version"
     AND NEW."cost_cents" IS NOT DISTINCT FROM OLD."cost_cents"
     AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
     AND NEW."ingest_key" IS NOT DISTINCT FROM OLD."ingest_key"
     AND NEW."payload_hash" IS NOT DISTINCT FROM OLD."payload_hash"
     AND NEW."payload_bytes" IS NOT DISTINCT FROM OLD."payload_bytes"
     AND NEW."ingest_version" IS NOT DISTINCT FROM OLD."ingest_version"
     AND NEW."disposition_code" IS NOT DISTINCT FROM OLD."disposition_code"
     AND NEW."retention_days" IS NOT DISTINCT FROM OLD."retention_days"
     AND NEW."expires_at" IS NOT DISTINCT FROM OLD."expires_at"
     AND NEW."source_policy_snapshot" IS NOT DISTINCT FROM OLD."source_policy_snapshot"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'raw-source/v2 rows are immutable except for one-way expiry'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "raw_source_record_v2_immutable_guard"
BEFORE UPDATE ON "raw_source_record"
FOR EACH ROW EXECUTE FUNCTION raw_source_record_v2_immutable_guard();

-- Retention is deliberately an UPDATE to the minimal expired receipt above. There is no physical
-- delete exception: provider facts and their hashes remain auditable after their payload expires.
CREATE OR REPLACE FUNCTION reject_raw_source_record_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'raw source physical deletion is forbidden; use one-way expiry receipt'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "raw_source_record_delete_guard"
BEFORE DELETE ON "raw_source_record"
FOR EACH ROW EXECUTE FUNCTION reject_raw_source_record_delete();

-- raw_source_record was originally granted DELETE by the discovery foundation migration.
-- Explicitly remove it now; the trigger also protects owner/cascade paths from erasing evidence.
REVOKE DELETE ON TABLE "raw_source_record" FROM app_user;

COMMIT;
