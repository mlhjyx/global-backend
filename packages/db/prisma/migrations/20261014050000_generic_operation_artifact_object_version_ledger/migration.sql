-- Generic operation artifacts: one content object serves every manifest with the
-- same bytes, and the bucket lifecycle expires that object by the age of its
-- current S3 version. Since this change the store copies a reused object onto
-- itself when a later manifest would outlive that age, so an object can have
-- more than one version over its life, and a content object that the lifecycle
-- already deleted can be written again under a new version.
--
-- Two things in this schema assumed exactly one version per object forever:
--
--   1. settle_tool_budget_artifact_manifest_with_receipt_v3 refused any
--      settlement whose VersionId differed from the one pinned on
--      generic_operation_artifact_object. After a lifecycle deletion that made
--      the next re-write of the same bytes fail with
--      GENERIC_OPERATION_ARTIFACT_INVALID (xin, 2026-10-14: 126 of 173 objects
--      were pinned to versions the bucket no longer held).
--   2. Personal-data erasure addressed only that pinned version. Deleting the
--      current version by VersionId makes the previous version current again
--      (verified on MinIO RELEASE.2025-09-07), so a refreshed object would have
--      kept its older bytes readable.
--
-- This migration keeps the pinned version as "the version the latest settlement
-- verified" and adds a ledger of every version a settlement ever recorded.
-- Settlement v4 moves the pin and appends to the ledger; cleanup enqueueing
-- creates one exact-version command per known version. The public manifest and
-- reference contracts do not change; no row is rewritten and the ledger is
-- backfilled from the pins that exist.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

CREATE TABLE "generic_operation_artifact_object_version" (
  "sha256" CHAR(64) NOT NULL,
  "privacy_class" VARCHAR(40) NOT NULL,
  "object_version_id" VARCHAR(1024) NOT NULL,
  "first_settled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generic_operation_artifact_object_version_pkey"
    PRIMARY KEY ("sha256", "privacy_class", "object_version_id"),
  CONSTRAINT "generic_operation_artifact_object_version_object_fkey"
    FOREIGN KEY ("sha256", "privacy_class")
    REFERENCES "generic_operation_artifact_object" ("sha256", "privacy_class")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "generic_operation_artifact_object_version_id_check" CHECK (
    char_length("object_version_id") BETWEEN 1 AND 1024
    AND "object_version_id" ~ '^[A-Za-z0-9._~+/=-]+$'
  )
);

INSERT INTO "generic_operation_artifact_object_version" (
  "sha256", "privacy_class", "object_version_id", "first_settled_at"
)
SELECT object."sha256", object."privacy_class", object."object_version_id",
  object."created_at"
FROM "generic_operation_artifact_object" object
WHERE object."object_version_id" IS NOT NULL
ON CONFLICT ON CONSTRAINT "generic_operation_artifact_object_version_pkey"
  DO NOTHING;

REVOKE ALL ON TABLE "generic_operation_artifact_object_version"
  FROM PUBLIC, app_user, execution_budget_platform_writer;

-- The one writer of version identity. The pin follows the latest verified
-- settlement; the ledger only grows. Both inputs are checked again here because
-- the function is SECURITY DEFINER.
CREATE FUNCTION record_generic_operation_artifact_object_version_v1(
  p_sha256 TEXT, p_privacy_class TEXT, p_object_version_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR p_privacy_class IS NULL
    OR p_privacy_class NOT IN (
      'PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT', 'PERSONAL_DATA'
    )
    OR p_object_version_id IS NULL
    OR char_length(p_object_version_id) NOT BETWEEN 1 AND 1024
    OR p_object_version_id !~ '^[A-Za-z0-9._~+/=-]+$'
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE "generic_operation_artifact_object" target
  SET "object_version_id" = p_object_version_id
  WHERE target."sha256" = p_sha256
    AND target."privacy_class" = p_privacy_class;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "generic_operation_artifact_object_version" (
    "sha256", "privacy_class", "object_version_id"
  ) VALUES (p_sha256, p_privacy_class, p_object_version_id)
  ON CONFLICT ON CONSTRAINT "generic_operation_artifact_object_version_pkey"
    DO NOTHING;
END
$$;

-- v4 = v3 with the version identity recorded instead of compared. The budget,
-- manifest, expected-facts, receipt and subject semantics are v2's, unchanged.
CREATE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v4(
  p_scope_key TEXT, p_operation_id UUID, p_observed_microusd BIGINT,
  p_manifest JSONB, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN, p_receipt_usage JSONB,
  p_receipt_cost_basis TEXT, p_subject_type TEXT, p_subject_id UUID,
  p_object_version_id TEXT
)
RETURNS TABLE(
  charged_microusd BIGINT, observed_microusd BIGINT, cap_variance BOOLEAN,
  status TEXT, replay BOOLEAN, reserved_microusd BIGINT, operation_id UUID,
  operation_key TEXT, account_id UUID, authority_id UUID,
  result_schema_version TEXT, result_schema TEXT, result_digest TEXT,
  result_json JSONB, receipt_usage JSONB, receipt_cost_basis TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  settlement RECORD;
  artifact "generic_operation_artifact"%ROWTYPE;
BEGIN
  IF p_object_version_id IS NULL
    OR char_length(p_object_version_id) NOT BETWEEN 1 AND 1024
    OR p_object_version_id !~ '^[A-Za-z0-9._~+/=-]+$'
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO settlement
  FROM settle_tool_budget_artifact_manifest_with_receipt_v2(
    p_scope_key, p_operation_id, p_observed_microusd, p_manifest,
    p_expected_http_status, p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked, p_receipt_usage, p_receipt_cost_basis,
    p_subject_type, p_subject_id
  );
  SELECT target.* INTO artifact
  FROM "generic_operation_artifact" target
  WHERE target."scope_key" = p_scope_key
    AND target."operation_id" = p_operation_id
  FOR SHARE;
  IF NOT FOUND OR artifact."sha256" IS DISTINCT FROM p_manifest->>'sha256' THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM record_generic_operation_artifact_object_version_v1(
    artifact."sha256", artifact."privacy_class", p_object_version_id
  );
  RETURN QUERY SELECT settlement.charged_microusd,
    settlement.observed_microusd, settlement.cap_variance,
    settlement.status, settlement.replay, settlement.reserved_microusd,
    settlement.operation_id, settlement.operation_key,
    settlement.account_id, settlement.authority_id,
    settlement.result_schema_version, settlement.result_schema,
    settlement.result_digest, settlement.result_json,
    settlement.receipt_usage, settlement.receipt_cost_basis;
END
$$;

-- Same signature, same fences and counts as before (20260824130000 as patched
-- by 20260901060000); the one change is the `eligible` set: one exact-version
-- command per version the ledger or the pin knows for an unreferenced object,
-- instead of one command for the pinned version only. The claim function calls
-- this on every claim, so versions recorded after the first enqueue get their
-- command on the next claim.
CREATE OR REPLACE FUNCTION enqueue_workspace_personal_artifact_cleanup_v1(
  p_workspace_id UUID, p_deletion_request_id UUID
)
RETURNS TABLE(
  command_count INTEGER, shared_hold_count INTEGER,
  version_hold_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  audit_row "generic_operation_artifact_subject_tombstone_audit"%ROWTYPE;
  inserted_count INTEGER := 0;
  shared_count INTEGER := 0;
  missing_version_count INTEGER := 0;
  digest_row RECORD;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_deletion_request_id IS NULL
  THEN
    RAISE EXCEPTION 'PERSONAL_ARTIFACT_CLEANUP_DENIED'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target.* INTO audit_row
  FROM "generic_operation_artifact_subject_tombstone_audit" target
  WHERE target."deletion_request_id" = p_deletion_request_id
    AND target."workspace_id" = p_workspace_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PERSONAL_ARTIFACT_CLEANUP_TOMBSTONE_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  FOR digest_row IN
    SELECT DISTINCT artifact."sha256"
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact" artifact
      ON artifact."scope_key" = subject."scope_key"
     AND artifact."id" = subject."artifact_id"
    WHERE subject."workspace_id" = audit_row."workspace_id"
      AND subject."subject_type" = audit_row."subject_type"
      AND subject."subject_id" = audit_row."subject_id"
    ORDER BY artifact."sha256"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'generic-operation-artifact-object:' || digest_row."sha256", 0
    ));
  END LOOP;

  WITH subject_objects AS (
    SELECT DISTINCT artifact."sha256"
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact" artifact
      ON artifact."scope_key" = subject."scope_key"
     AND artifact."id" = subject."artifact_id"
    WHERE subject."workspace_id" = audit_row."workspace_id"
      AND subject."subject_type" = audit_row."subject_type"
      AND subject."subject_id" = audit_row."subject_id"
      AND artifact."privacy_class" = 'PERSONAL_DATA'
  )
  SELECT count(*)::INTEGER INTO shared_count
  FROM subject_objects candidate
  WHERE EXISTS (
    SELECT 1
    FROM "generic_operation_artifact" shared_artifact
    JOIN "generic_operation_artifact_subject" shared_subject
      ON shared_subject."scope_key" = shared_artifact."scope_key"
     AND shared_subject."artifact_id" = shared_artifact."id"
    WHERE shared_artifact."sha256" = candidate."sha256"
      AND shared_artifact."privacy_class" = 'PERSONAL_DATA'
      AND NOT EXISTS (
        SELECT 1
        FROM "generic_operation_artifact_subject_tombstone" shared_tombstone
        WHERE shared_tombstone."workspace_id" = shared_subject."workspace_id"
          AND shared_tombstone."subject_type" = shared_subject."subject_type"
          AND shared_tombstone."subject_id" = shared_subject."subject_id"
      )
  );

  WITH subject_objects AS (
    SELECT DISTINCT artifact."sha256"
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact" artifact
      ON artifact."scope_key" = subject."scope_key"
     AND artifact."id" = subject."artifact_id"
    WHERE subject."workspace_id" = audit_row."workspace_id"
      AND subject."subject_type" = audit_row."subject_type"
      AND subject."subject_id" = audit_row."subject_id"
      AND artifact."privacy_class" = 'PERSONAL_DATA'
  )
  SELECT count(*)::INTEGER INTO missing_version_count
  FROM subject_objects candidate
  JOIN "generic_operation_artifact_object" object
    ON object."sha256" = candidate."sha256"
   AND object."privacy_class" = 'PERSONAL_DATA'
  WHERE object."object_version_id" IS NULL;

  WITH eligible_objects AS (
    SELECT artifact."sha256",
      min(artifact."id"::text)::UUID AS artifact_id
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact" artifact
      ON artifact."scope_key" = subject."scope_key"
     AND artifact."id" = subject."artifact_id"
    JOIN "generic_operation_artifact_object" object
      ON object."sha256" = artifact."sha256"
     AND object."privacy_class" = artifact."privacy_class"
    WHERE subject."workspace_id" = audit_row."workspace_id"
      AND subject."subject_type" = audit_row."subject_type"
      AND subject."subject_id" = audit_row."subject_id"
      AND artifact."privacy_class" = 'PERSONAL_DATA'
      AND object."object_version_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "generic_operation_artifact" shared_artifact
        JOIN "generic_operation_artifact_subject" shared_subject
          ON shared_subject."scope_key" = shared_artifact."scope_key"
         AND shared_subject."artifact_id" = shared_artifact."id"
        WHERE shared_artifact."sha256" = artifact."sha256"
          AND shared_artifact."privacy_class" = 'PERSONAL_DATA'
          AND NOT EXISTS (
            SELECT 1
            FROM "generic_operation_artifact_subject_tombstone" shared_tombstone
            WHERE shared_tombstone."workspace_id" = shared_subject."workspace_id"
              AND shared_tombstone."subject_type" = shared_subject."subject_type"
              AND shared_tombstone."subject_id" = shared_subject."subject_id"
          )
      )
    GROUP BY artifact."sha256"
  ), eligible AS (
    SELECT candidate."sha256", candidate.artifact_id,
      known."object_version_id"
    FROM eligible_objects candidate
    JOIN LATERAL (
      SELECT ledger."object_version_id"
      FROM "generic_operation_artifact_object_version" ledger
      WHERE ledger."sha256" = candidate."sha256"
        AND ledger."privacy_class" = 'PERSONAL_DATA'
      UNION
      SELECT object."object_version_id"
      FROM "generic_operation_artifact_object" object
      WHERE object."sha256" = candidate."sha256"
        AND object."privacy_class" = 'PERSONAL_DATA'
        AND object."object_version_id" IS NOT NULL
    ) known ON true
  ), inserted AS (
    INSERT INTO "personal_artifact_cleanup_command"(
      "workspace_id", "deletion_request_id", "artifact_id", "sha256",
      "object_version_id", "tombstoned_at"
    )
    SELECT p_workspace_id, p_deletion_request_id, eligible.artifact_id,
      eligible."sha256", eligible."object_version_id", audit_row."tombstoned_at"
    FROM eligible
    ON CONFLICT ON CONSTRAINT
      "personal_artifact_cleanup_command_request_object_key" DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO inserted_count FROM inserted;
  RETURN QUERY SELECT inserted_count, shared_count, missing_version_count;
END
$$;

REVOKE ALL ON FUNCTION
  record_generic_operation_artifact_object_version_v1(TEXT,TEXT,TEXT),
  settle_tool_budget_artifact_manifest_with_receipt_v4(TEXT,UUID,BIGINT,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,JSONB,TEXT,TEXT,UUID,TEXT)
FROM PUBLIC, app_user, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION
  settle_tool_budget_artifact_manifest_with_receipt_v4(TEXT,UUID,BIGINT,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,JSONB,TEXT,TEXT,UUID,TEXT)
TO app_user, execution_budget_platform_writer;

COMMIT;
