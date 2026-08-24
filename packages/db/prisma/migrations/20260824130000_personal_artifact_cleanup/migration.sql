BEGIN;

ALTER TABLE "generic_operation_artifact_object"
  ADD COLUMN "object_version_id" VARCHAR(1024),
  ADD CONSTRAINT "generic_operation_artifact_object_version_check"
    CHECK (
      "object_version_id" IS NULL
      OR (
        char_length("object_version_id") BETWEEN 1 AND 1024
        AND "object_version_id" ~ '^[A-Za-z0-9._~+/=-]+$'
      )
    );

CREATE TABLE "personal_artifact_cleanup_command" (
  "command_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "deletion_request_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "object_version_id" VARCHAR(1024) NOT NULL,
  "tombstoned_at" TIMESTAMPTZ(3) NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "object_status" VARCHAR(16),
  "last_error_code" VARCHAR(80),
  "claimed_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "personal_artifact_cleanup_command_pkey"
    PRIMARY KEY ("command_id"),
  CONSTRAINT "personal_artifact_cleanup_command_request_object_key"
    UNIQUE ("deletion_request_id", "sha256", "object_version_id"),
  CONSTRAINT "personal_artifact_cleanup_command_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "personal_artifact_cleanup_command_request_fkey"
    FOREIGN KEY ("deletion_request_id") REFERENCES "deletion_request"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "personal_artifact_cleanup_command_artifact_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "generic_operation_artifact"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "personal_artifact_cleanup_command_digest_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "personal_artifact_cleanup_command_version_check"
    CHECK (
      char_length("object_version_id") BETWEEN 1 AND 1024
      AND "object_version_id" ~ '^[A-Za-z0-9._~+/=-]+$'
    ),
  CONSTRAINT "personal_artifact_cleanup_command_attempt_check"
    CHECK ("attempt" >= 1 AND "attempt" <= 2147483647),
  CONSTRAINT "personal_artifact_cleanup_command_status_check"
    CHECK ("status" IN ('PENDING','CLAIMED','RETRY','COMPLETED')),
  CONSTRAINT "personal_artifact_cleanup_command_object_status_check"
    CHECK (
      ("status" = 'COMPLETED' AND "object_status" IN ('DELETED','ABSENT')
        AND "completed_at" IS NOT NULL)
      OR ("status" <> 'COMPLETED' AND "object_status" IS NULL
        AND "completed_at" IS NULL)
    ),
  CONSTRAINT "personal_artifact_cleanup_command_error_check"
    CHECK (
      "last_error_code" IS NULL
      OR "last_error_code" = 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE'
    )
);
CREATE INDEX "personal_artifact_cleanup_command_claim_idx"
  ON "personal_artifact_cleanup_command"(
    "workspace_id", "deletion_request_id", "status", "created_at"
  );

ALTER TABLE "personal_artifact_cleanup_command" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_artifact_cleanup_command" FORCE ROW LEVEL SECURITY;
CREATE POLICY "personal_artifact_cleanup_command_scope_isolation"
  ON "personal_artifact_cleanup_command"
  USING (
    session_user = 'app_user'
    AND current_setting('role', true) IS NOT DISTINCT FROM 'none'
    AND "workspace_id" IS NOT DISTINCT FROM current_workspace_id()
  )
  WITH CHECK (
    session_user = 'app_user'
    AND current_setting('role', true) IS NOT DISTINCT FROM 'none'
    AND "workspace_id" IS NOT DISTINCT FROM current_workspace_id()
  );

-- The public manifest/reference remains unchanged. This wrapper binds the
-- physical VersionId only after the existing settlement atomically appended
-- the trusted artifact/object row. Replay must present the identical version.
CREATE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v3(
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
  changed INTEGER;
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
  UPDATE "generic_operation_artifact_object" target
  SET "object_version_id" = p_object_version_id
  WHERE target."sha256" = artifact."sha256"
    AND (
      target."object_version_id" IS NULL
      OR target."object_version_id" = p_object_version_id
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
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

CREATE FUNCTION enforce_personal_artifact_object_version_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."privacy_class" = 'PERSONAL_DATA' AND NOT EXISTS (
    SELECT 1 FROM "generic_operation_artifact_object" object
    WHERE object."sha256" = NEW."sha256"
      AND object."object_version_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_OBJECT_VERSION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER "generic_operation_artifact_personal_version_guard"
AFTER INSERT OR UPDATE OF "privacy_class" ON "generic_operation_artifact"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_personal_artifact_object_version_v1();

-- Serialize every future subject binding with cleanup command creation for the
-- same digest. Once physical cleanup is planned, that immutable version can
-- never acquire a new logical subject reference.
CREATE FUNCTION enforce_personal_artifact_cleanup_binding_fence_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE artifact_digest TEXT;
BEGIN
  SELECT artifact."sha256" INTO artifact_digest
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = NEW."scope_key"
    AND artifact."id" = NEW."artifact_id";
  IF artifact_digest IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-object:' || artifact_digest, 0
  ));
  IF EXISTS (
    SELECT 1 FROM "personal_artifact_cleanup_command" cleanup
    WHERE cleanup."sha256" = artifact_digest
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "generic_operation_artifact_subject_cleanup_fence"
BEFORE INSERT ON "generic_operation_artifact_subject"
FOR EACH ROW EXECUTE FUNCTION enforce_personal_artifact_cleanup_binding_fence_v1();

-- Cross-workspace shared-reference inspection stays inside this trusted
-- aggregate function. It returns counts only; no foreign workspace, subject or
-- artifact identifier can cross back to the app_user caller.
CREATE FUNCTION enqueue_workspace_personal_artifact_cleanup_v1(
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
  WHERE object."object_version_id" IS NULL;

  WITH eligible AS (
    SELECT artifact."sha256",
      min(artifact."id"::text)::UUID AS artifact_id,
      object."object_version_id"
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact" artifact
      ON artifact."scope_key" = subject."scope_key"
     AND artifact."id" = subject."artifact_id"
    JOIN "generic_operation_artifact_object" object
      ON object."sha256" = artifact."sha256"
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
    GROUP BY artifact."sha256", object."object_version_id"
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

CREATE FUNCTION inspect_workspace_personal_artifact_cleanup_v1(
  p_workspace_id UUID, p_deletion_request_id UUID
)
RETURNS TABLE(
  fence_committed BOOLEAN, shared_hold BOOLEAN, version_hold BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  request_exists BOOLEAN;
  fence_exists BOOLEAN;
  audit_row "generic_operation_artifact_subject_tombstone_audit"%ROWTYPE;
  shared_count INTEGER;
  version_count INTEGER;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN RETURN; END IF;
  SELECT EXISTS(
    SELECT 1 FROM "deletion_request" request
    WHERE request."id" = p_deletion_request_id
      AND request."workspace_id" = p_workspace_id
  ) INTO request_exists;
  IF NOT request_exists THEN RETURN; END IF;
  SELECT EXISTS(
    SELECT 1
    FROM "generic_operation_artifact_subject_tombstone_audit" audit_source
    WHERE audit_source."deletion_request_id" = p_deletion_request_id
      AND audit_source."workspace_id" = p_workspace_id
  ) INTO fence_exists;
  IF NOT fence_exists THEN
    RETURN QUERY SELECT false, false, false;
    RETURN;
  END IF;
  SELECT target.* INTO audit_row
  FROM "generic_operation_artifact_subject_tombstone_audit" target
  WHERE target."deletion_request_id" = p_deletion_request_id
    AND target."workspace_id" = p_workspace_id;
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
  SELECT count(*)::INTEGER INTO version_count
  FROM subject_objects candidate
  JOIN "generic_operation_artifact_object" object
    ON object."sha256" = candidate."sha256"
  WHERE object."object_version_id" IS NULL;
  RETURN QUERY SELECT true, shared_count > 0, version_count > 0;
END
$$;

CREATE FUNCTION claim_workspace_personal_artifact_cleanup_v1(
  p_workspace_id UUID, p_deletion_request_id UUID
)
RETURNS SETOF "personal_artifact_cleanup_command"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  candidate "personal_artifact_cleanup_command"%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "generic_operation_artifact_subject_tombstone_audit" audit
    WHERE audit."deletion_request_id" = p_deletion_request_id
      AND audit."workspace_id" = p_workspace_id
  ) THEN RETURN; END IF;
  -- A HOLD-only request already has a durable workflow. Re-evaluate eligibility
  -- on every claim so a released shared fence or newly bound VersionId creates
  -- the command without requiring another external Outbox dispatch.
  PERFORM * FROM enqueue_workspace_personal_artifact_cleanup_v1(
    p_workspace_id, p_deletion_request_id
  );
  SELECT target.* INTO candidate
  FROM "personal_artifact_cleanup_command" target
  WHERE target."workspace_id" = p_workspace_id
    AND target."deletion_request_id" = p_deletion_request_id
    AND target."status" IN ('PENDING','RETRY','CLAIMED')
  ORDER BY target."created_at", target."command_id"
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'generic-operation-artifact-object:' || candidate."sha256", 0
    ));
    IF EXISTS (
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
    ) THEN
      RETURN;
    END IF;
    IF candidate."status" <> 'CLAIMED' THEN
      UPDATE "personal_artifact_cleanup_command" target
      SET "status" = 'CLAIMED', "claimed_at" = statement_timestamp()
      WHERE target."command_id" = candidate."command_id"
      RETURNING target.* INTO candidate;
    END IF;
    RETURN NEXT candidate;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "personal_artifact_cleanup_command" target
    WHERE target."workspace_id" = p_workspace_id
      AND target."deletion_request_id" = p_deletion_request_id
      AND target."status" <> 'COMPLETED'
  ) THEN
    SELECT target.* INTO candidate
    FROM "personal_artifact_cleanup_command" target
    WHERE target."workspace_id" = p_workspace_id
      AND target."deletion_request_id" = p_deletion_request_id
      AND target."status" = 'COMPLETED'
    ORDER BY target."completed_at" DESC, target."command_id"
    LIMIT 1;
    IF FOUND THEN RETURN NEXT candidate; END IF;
  END IF;
END
$$;

CREATE FUNCTION complete_workspace_personal_artifact_cleanup_v1(
  p_workspace_id UUID, p_command_id UUID, p_attempt INTEGER,
  p_object_status TEXT
)
RETURNS SETOF "personal_artifact_cleanup_command"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE stored "personal_artifact_cleanup_command"%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_object_status NOT IN ('DELETED','ABSENT')
  THEN RETURN; END IF;
  UPDATE "personal_artifact_cleanup_command" target
  SET "status" = 'COMPLETED', "object_status" = p_object_status,
      "last_error_code" = NULL, "completed_at" = statement_timestamp()
  WHERE target."command_id" = p_command_id
    AND target."workspace_id" = p_workspace_id
    AND target."attempt" = p_attempt
    AND target."status" = 'CLAIMED'
  RETURNING target.* INTO stored;
  IF NOT FOUND THEN
    SELECT target.* INTO stored
    FROM "personal_artifact_cleanup_command" target
    WHERE target."command_id" = p_command_id
      AND target."workspace_id" = p_workspace_id
      AND target."attempt" = p_attempt
      AND target."status" = 'COMPLETED'
      AND target."object_status" = p_object_status;
  END IF;
  IF FOUND THEN RETURN NEXT stored; END IF;
END
$$;

CREATE FUNCTION retry_workspace_personal_artifact_cleanup_v1(
  p_workspace_id UUID, p_command_id UUID, p_attempt INTEGER,
  p_error_code TEXT
)
RETURNS SETOF "personal_artifact_cleanup_command"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE stored "personal_artifact_cleanup_command"%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_error_code <> 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE'
  THEN RETURN; END IF;
  UPDATE "personal_artifact_cleanup_command" target
  SET "status" = 'RETRY', "attempt" = target."attempt" + 1,
      "last_error_code" = p_error_code, "claimed_at" = NULL
  WHERE target."command_id" = p_command_id
    AND target."workspace_id" = p_workspace_id
    AND target."attempt" = p_attempt
    AND target."status" = 'CLAIMED'
  RETURNING target.* INTO stored;
  IF FOUND THEN RETURN NEXT stored; END IF;
END
$$;

REVOKE ALL ON TABLE "personal_artifact_cleanup_command"
  FROM PUBLIC, app_user, execution_budget_platform_writer;
REVOKE ALL ON FUNCTION
  settle_tool_budget_artifact_manifest_with_receipt_v3(TEXT,UUID,BIGINT,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,JSONB,TEXT,TEXT,UUID,TEXT),
  enforce_personal_artifact_object_version_v1(),
  enforce_personal_artifact_cleanup_binding_fence_v1(),
  enqueue_workspace_personal_artifact_cleanup_v1(UUID,UUID),
  inspect_workspace_personal_artifact_cleanup_v1(UUID,UUID),
  claim_workspace_personal_artifact_cleanup_v1(UUID,UUID),
  complete_workspace_personal_artifact_cleanup_v1(UUID,UUID,INTEGER,TEXT),
  retry_workspace_personal_artifact_cleanup_v1(UUID,UUID,INTEGER,TEXT)
FROM PUBLIC, app_user, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION
  settle_tool_budget_artifact_manifest_with_receipt_v3(TEXT,UUID,BIGINT,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,JSONB,TEXT,TEXT,UUID,TEXT)
TO app_user, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION
  enqueue_workspace_personal_artifact_cleanup_v1(UUID,UUID),
  inspect_workspace_personal_artifact_cleanup_v1(UUID,UUID),
  claim_workspace_personal_artifact_cleanup_v1(UUID,UUID),
  complete_workspace_personal_artifact_cleanup_v1(UUID,UUID,INTEGER,TEXT),
  retry_workspace_personal_artifact_cleanup_v1(UUID,UUID,INTEGER,TEXT)
TO app_user;

COMMIT;
