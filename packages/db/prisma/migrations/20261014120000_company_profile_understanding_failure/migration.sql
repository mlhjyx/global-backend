-- Understanding failure write-back (2026-10-13). Since 2026-08-24 the seller-onboarding
-- understanding workflow has failed at its first crawl: the G3 per-call subject gate (#565) held
-- every crawl4ai.fetch that named no artifact subject, and the workflow left company_profile at
-- ENRICHING with nothing recorded. Two nullable columns let the workflow return the row to DRAFT
-- and keep what stopped it: the stage and the failure type as `stage:errorType`, one closed token
-- each, never a message or any crawled content (the CHECK admits only that shape, and both columns
-- are set or cleared together). A new ENRICHING attempt clears both.
--
-- Additive, no backfill: rows already stuck at ENRICHING are not touched (no run is live for them;
-- they can be re-created now that the seller profile is an artifact subject kind, below). app_user
-- already holds UPDATE on company_profile (20261010090000), and the API maps rows through
-- CompanyDto, so the contract is unchanged. Rollback: a later migration dropping the constraint
-- and the two columns.
--
-- Seller profile artifact subject (owner decision 2026-10-14, option A). The understanding crawls
-- bind their PERSONAL_DATA crawl4ai-fetch/v1 artifacts to the seller company_profile being
-- understood, as a third subject kind `company_profile`. `company` keeps meaning canonical_company
-- (a discovered buyer), so every subject row still names exactly one table. Every CHECK and every
-- subject function that admitted ('contact', 'company') admits the new kind; each function below
-- is its newest definition (source migration named above it) with only the kind list widened,
-- plus, in assert_workspace_generic_operation_artifact_subject_v1, the lookup that proves a
-- company_profile row exists in the same workspace. Owner, SECURITY DEFINER, search_path and
-- grants are unchanged (CREATE OR REPLACE keeps owner and grants).
--
-- company_profile is not a DSR subject: the deletion API, DeletionCompleted and the deletion
-- workflow keep contact | company. A seller profile has no suppression state, so the execution
-- hold reader reports only its tombstone. No path deletes a company_profile today, and a
-- workspace cannot be deleted while any subject row references it (RESTRICT foreign keys). The
-- subject row has no foreign key to the profile, so a delete guard keeps a profile from going
-- while an artifact is still bound to it without a tombstone: whatever deletes a seller profile
-- (a future tenant deletion) must first tombstone the subject through
-- tombstone_workspace_generic_operation_artifact_subject_v1 under a deletion_request naming it,
-- which also hands the bound objects to the personal artifact cleanup.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "company_profile"
  ADD COLUMN "understanding_failed_at" TIMESTAMPTZ(3),
  ADD COLUMN "understanding_last_error" VARCHAR(120),
  ADD CONSTRAINT "company_profile_understanding_failure_check"
    CHECK (
      ("understanding_failed_at" IS NULL) = ("understanding_last_error" IS NULL)
      AND (
        "understanding_last_error" IS NULL
        OR "understanding_last_error" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}:[A-Za-z][A-Za-z0-9_]{0,63}$'
      )
    );

-- The four subject-kind CHECKs (20260824110000), widened. The new predicate is weaker than the
-- old, so every existing row satisfies it.
ALTER TABLE "tool_budget_operation"
  DROP CONSTRAINT "tool_budget_operation_expected_artifact_subject_check",
  ADD CONSTRAINT "tool_budget_operation_expected_artifact_subject_check"
  CHECK (
    ("expected_artifact_subject_type" IS NULL) =
      ("expected_artifact_subject_id" IS NULL)
    AND (
      "expected_artifact_subject_type" IS NULL
      OR "expected_artifact_subject_type" IN ('contact', 'company', 'company_profile')
    )
  );
ALTER TABLE "generic_operation_artifact_subject"
  DROP CONSTRAINT "generic_operation_artifact_subject_type_check",
  ADD CONSTRAINT "generic_operation_artifact_subject_type_check"
    CHECK ("subject_type" IN ('contact', 'company', 'company_profile'));
ALTER TABLE "generic_operation_artifact_subject_tombstone"
  DROP CONSTRAINT "generic_operation_artifact_subject_tombstone_type_check",
  ADD CONSTRAINT "generic_operation_artifact_subject_tombstone_type_check"
    CHECK ("subject_type" IN ('contact', 'company', 'company_profile'));
ALTER TABLE "generic_operation_artifact_subject_tombstone_audit"
  DROP CONSTRAINT "generic_operation_artifact_subject_tombstone_audit_type_check",
  ADD CONSTRAINT "generic_operation_artifact_subject_tombstone_audit_type_check"
    CHECK ("subject_type" IN ('contact', 'company', 'company_profile'));

-- assert_workspace_generic_operation_artifact_subject_v1: newest definition in 20260824110000; kinds widened; a company_profile must exist in the same workspace.
CREATE OR REPLACE FUNCTION assert_workspace_generic_operation_artifact_subject_v1(
  p_workspace_id UUID, p_subject_type TEXT, p_subject_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
    OR p_subject_type NOT IN ('contact', 'company', 'company_profile')
    OR p_subject_id IS NULL
    OR (
      p_subject_type = 'contact'
      AND NOT EXISTS (
        SELECT 1 FROM "canonical_contact" contact
        WHERE contact."id" = p_subject_id
          AND contact."workspace_id" = p_workspace_id
      )
    )
    OR (
      p_subject_type = 'company'
      AND NOT EXISTS (
        SELECT 1 FROM "canonical_company" company
        WHERE company."id" = p_subject_id
          AND company."workspace_id" = p_workspace_id
      )
    )
    -- The seller profile row stays key-share locked until the binding commits:
    -- a concurrent profile delete waits, then its guard sees the binding.
    OR (
      p_subject_type = 'company_profile'
      AND NOT EXISTS (
        SELECT 1 FROM "company_profile" profile
        WHERE profile."id" = p_subject_id
          AND profile."workspace_id" = p_workspace_id
        FOR KEY SHARE
      )
    )
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

-- bind_workspace_generic_operation_artifact_subject_v1: newest definition in 20260824110000; kinds widened.
CREATE OR REPLACE FUNCTION bind_workspace_generic_operation_artifact_subject_v1(
  p_workspace_id UUID, p_artifact_id UUID, p_subject_type TEXT,
  p_subject_id UUID
)
RETURNS TABLE(
  artifact_id UUID, workspace_id UUID, subject_type VARCHAR(16),
  subject_id UUID, created_at TIMESTAMPTZ(3), replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  artifact "generic_operation_artifact"%ROWTYPE;
  existing "generic_operation_artifact_subject"%ROWTYPE;
  stored "generic_operation_artifact_subject"%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_artifact_id IS NULL
    OR p_subject_type NOT IN ('contact', 'company', 'company_profile')
    OR p_subject_id IS NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM assert_workspace_generic_operation_artifact_subject_v1(
    p_workspace_id, p_subject_type, p_subject_id
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-subject:' || p_workspace_id::text || ':' ||
      p_subject_type || ':' || p_subject_id::text,
    0
  ));

  SELECT target.* INTO artifact
  FROM "generic_operation_artifact" target
  WHERE target."scope_key" = p_workspace_id::text
    AND target."workspace_id" = p_workspace_id
    AND target."id" = p_artifact_id
  FOR SHARE;
  IF NOT FOUND OR artifact."privacy_class" <> 'PERSONAL_DATA' THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO existing
  FROM "generic_operation_artifact_subject" target
  WHERE target."artifact_id" = p_artifact_id
  FOR SHARE;
  IF FOUND THEN
    IF existing."workspace_id" IS DISTINCT FROM p_workspace_id
      OR existing."scope_key" IS DISTINCT FROM p_workspace_id::text
      OR existing."subject_type" IS DISTINCT FROM p_subject_type
      OR existing."subject_id" IS DISTINCT FROM p_subject_id
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT existing."artifact_id", existing."workspace_id",
      existing."subject_type", existing."subject_id", existing."created_at",
      true;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "generic_operation_artifact_subject_tombstone" tombstone
    WHERE tombstone."workspace_id" = p_workspace_id
      AND tombstone."subject_type" = p_subject_type
      AND tombstone."subject_id" = p_subject_id
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "generic_operation_artifact_subject"(
    "artifact_id", "scope_key", "workspace_id", "subject_type", "subject_id"
  ) VALUES (
    p_artifact_id, p_workspace_id::text, p_workspace_id,
    p_subject_type, p_subject_id
  ) RETURNING * INTO stored;
  RETURN QUERY SELECT stored."artifact_id", stored."workspace_id",
    stored."subject_type", stored."subject_id", stored."created_at", false;
END
$$;

-- find_workspace_generic_operation_artifacts_by_subject_v1: newest definition in 20260824110000; kinds widened.
CREATE OR REPLACE FUNCTION find_workspace_generic_operation_artifacts_by_subject_v1(
  p_workspace_id UUID, p_subject_type TEXT, p_subject_id UUID
)
RETURNS TABLE(
  artifact_id UUID, workspace_id UUID, subject_type VARCHAR(16),
  subject_id UUID, created_at TIMESTAMPTZ(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_subject_type NOT IN ('contact', 'company', 'company_profile')
    OR p_subject_id IS NULL
  THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT subject."artifact_id", subject."workspace_id",
    subject."subject_type", subject."subject_id", subject."created_at"
  FROM "generic_operation_artifact_subject" subject
  WHERE subject."scope_key" = p_workspace_id::text
    AND subject."workspace_id" = p_workspace_id
    AND subject."subject_type" = p_subject_type
    AND subject."subject_id" = p_subject_id
  ORDER BY subject."artifact_id";
END
$$;

-- tombstone_workspace_generic_operation_artifact_subject_v1: newest definition in 20260824110000; kinds widened.
CREATE OR REPLACE FUNCTION tombstone_workspace_generic_operation_artifact_subject_v1(
  p_workspace_id UUID, p_subject_type TEXT, p_subject_id UUID,
  p_deletion_request_id UUID
)
RETURNS TABLE(
  workspace_id UUID, subject_type VARCHAR(16), subject_id UUID,
  deletion_request_id UUID, tombstoned_at TIMESTAMPTZ(3),
  artifact_count INTEGER, replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  request "deletion_request"%ROWTYPE;
  existing_audit "generic_operation_artifact_subject_tombstone_audit"%ROWTYPE;
  stored_audit "generic_operation_artifact_subject_tombstone_audit"%ROWTYPE;
  matched_count INTEGER;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_subject_type NOT IN ('contact', 'company', 'company_profile')
    OR p_subject_id IS NULL
    OR p_deletion_request_id IS NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-subject:' || p_workspace_id::text || ':' ||
      p_subject_type || ':' || p_subject_id::text,
    0
  ));
  SELECT target.* INTO request
  FROM "deletion_request" target
  WHERE target."id" = p_deletion_request_id
    AND target."workspace_id" = p_workspace_id
    AND target."subject_type" = p_subject_type
    AND target."subject_id" = p_subject_id
    AND target."status" IN ('RECEIVED', 'FROZEN', 'ERASING', 'COMPLETED')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "generic_operation_artifact_subject_tombstone"(
    "workspace_id", "subject_type", "subject_id"
  ) VALUES (p_workspace_id, p_subject_type, p_subject_id)
  ON CONFLICT ON CONSTRAINT
    "generic_operation_artifact_subject_tombstone_pkey" DO NOTHING;
  SELECT count(*)::INTEGER INTO matched_count
  FROM "generic_operation_artifact_subject" subject
  WHERE subject."workspace_id" = p_workspace_id
    AND subject."subject_type" = p_subject_type
    AND subject."subject_id" = p_subject_id;
  SELECT target.* INTO existing_audit
  FROM "generic_operation_artifact_subject_tombstone_audit" target
  WHERE target."deletion_request_id" = p_deletion_request_id
  FOR SHARE;
  IF FOUND THEN
    IF existing_audit."workspace_id" IS DISTINCT FROM p_workspace_id
      OR existing_audit."subject_type" IS DISTINCT FROM p_subject_type
      OR existing_audit."subject_id" IS DISTINCT FROM p_subject_id
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT existing_audit."workspace_id",
      existing_audit."subject_type", existing_audit."subject_id",
      existing_audit."deletion_request_id",
      existing_audit."tombstoned_at", matched_count, true;
    RETURN;
  END IF;

  INSERT INTO "generic_operation_artifact_subject_tombstone_audit"(
    "workspace_id", "subject_type", "subject_id", "deletion_request_id"
  ) VALUES (
    p_workspace_id, p_subject_type, p_subject_id, p_deletion_request_id
  ) RETURNING * INTO stored_audit;
  RETURN QUERY SELECT stored_audit."workspace_id",
    stored_audit."subject_type", stored_audit."subject_id",
    stored_audit."deletion_request_id",
    stored_audit."tombstoned_at", matched_count, false;
END
$$;

-- find_workspace_generic_operation_artifact_subject_execution_hold_v1: newest definition in 20260925090000; kinds widened; the suppression CASE names 'contact' instead of ELSE, so a profile is never suppressed.
CREATE OR REPLACE FUNCTION find_workspace_generic_operation_artifact_subject_execution_hold_v1(
  p_workspace_id UUID, p_subject_type TEXT, p_subject_id UUID
)
RETURNS TABLE(tombstoned BOOLEAN, suppressed BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_subject_type NOT IN ('contact', 'company', 'company_profile')
    OR p_subject_id IS NULL
  THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT
    EXISTS (
      SELECT 1 FROM "generic_operation_artifact_subject_tombstone" tombstone
      WHERE tombstone."workspace_id" = p_workspace_id
        AND tombstone."subject_type" = p_subject_type
        AND tombstone."subject_id" = p_subject_id
    ),
    EXISTS (
      SELECT 1 FROM "canonical_company" company
      WHERE company."workspace_id" = p_workspace_id
        AND company."status" = 'SUPPRESSED'
        AND company."id" = CASE p_subject_type
          WHEN 'company' THEN p_subject_id
          WHEN 'contact' THEN (
            SELECT contact."company_id" FROM "canonical_contact" contact
            WHERE contact."workspace_id" = p_workspace_id
              AND contact."id" = p_subject_id
          )
        END
    );
END
$$;

-- enforce_tool_budget_expected_artifact_subject_v1: newest definition in 20260824110000; kinds widened.
CREATE OR REPLACE FUNCTION enforce_tool_budget_expected_artifact_subject_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_operation "tool_budget_operation"%ROWTYPE;
  privacy_class TEXT;
  has_subject BOOLEAN;
BEGIN
  SELECT target.* INTO current_operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = NEW."scope_key"
    AND target."id" = NEW."id";
  privacy_class :=
    current_operation."expected_artifact"->'manifest'->>'privacyClass';
  has_subject :=
    current_operation."expected_artifact_subject_type" IS NOT NULL
    AND current_operation."expected_artifact_subject_id" IS NOT NULL;
  IF current_operation."expected_artifact" IS NULL THEN
    IF current_operation."expected_artifact_subject_type" IS NOT NULL
      OR current_operation."expected_artifact_subject_id" IS NOT NULL
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF privacy_class = 'PERSONAL_DATA' THEN
    IF current_operation."scope_key" = 'platform'
      OR NOT has_subject
      OR current_operation."expected_artifact_subject_type" NOT IN ('contact', 'company', 'company_profile')
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF has_subject
    OR current_operation."expected_artifact_subject_type" IS NOT NULL
    OR current_operation."expected_artifact_subject_id" IS NOT NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

-- mark_tool_budget_result_unknown_v4: newest definition in 20260824110000; kinds widened.
CREATE OR REPLACE FUNCTION mark_tool_budget_result_unknown_v4(
  p_scope_key TEXT, p_operation_id UUID, p_expected_manifest JSONB,
  p_expected_http_status SMALLINT, p_expected_http_ok BOOLEAN,
  p_expected_sanitized_url TEXT, p_expected_content_hash TEXT,
  p_expected_blocked_code TEXT, p_expected_robots_blocked BOOLEAN,
  p_subject_type TEXT, p_subject_id UUID
)
RETURNS TABLE(
  reserved_cents BIGINT, status TEXT, replay BOOLEAN, recoverable BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  transition RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  privacy_class TEXT := p_expected_manifest->>'privacyClass';
  has_subject BOOLEAN := p_subject_type IS NOT NULL AND p_subject_id IS NOT NULL;
BEGIN
  IF (p_subject_type IS NULL) IS DISTINCT FROM (p_subject_id IS NULL)
    OR (p_expected_manifest IS NULL AND has_subject)
    OR (
      p_expected_manifest IS NOT NULL
      AND (privacy_class = 'PERSONAL_DATA') IS DISTINCT FROM has_subject
    )
    OR (has_subject AND p_subject_type NOT IN ('contact', 'company', 'company_profile'))
    OR (privacy_class = 'PERSONAL_DATA' AND p_scope_key = 'platform')
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF has_subject THEN
    BEGIN
      PERFORM assert_workspace_generic_operation_artifact_subject_v1(
        p_scope_key::UUID, p_subject_type, p_subject_id
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
        USING ERRCODE = 'P0001';
    END;
  END IF;
  SELECT * INTO transition
  FROM mark_tool_budget_result_unknown_v3(
    p_scope_key, p_operation_id, p_expected_manifest,
    p_expected_http_status, p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR UPDATE;
  IF transition.replay THEN
    IF operation."expected_artifact_subject_type" IS DISTINCT FROM p_subject_type
      OR operation."expected_artifact_subject_id" IS DISTINCT FROM p_subject_id
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    UPDATE "tool_budget_operation" target
    SET "expected_artifact_subject_type" = p_subject_type,
        "expected_artifact_subject_id" = p_subject_id
    WHERE target."scope_key" = p_scope_key
      AND target."id" = p_operation_id;
  END IF;
  RETURN QUERY SELECT transition.reserved_cents, transition.status,
    transition.replay, transition.recoverable;
END
$$;

-- load_tool_budget_result_unknown_artifact_v4: newest definition in 20260824110000; kinds widened.
CREATE OR REPLACE FUNCTION load_tool_budget_result_unknown_artifact_v4(
  p_scope_key TEXT, p_operation_id UUID, p_authority_id UUID,
  p_subject_type TEXT, p_subject_id UUID
)
RETURNS TABLE(
  expected_manifest JSONB, expected_http_status SMALLINT,
  expected_http_ok BOOLEAN, expected_sanitized_url VARCHAR(2000),
  expected_content_hash CHAR(24), expected_blocked_code VARCHAR(80),
  expected_robots_blocked BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  loaded RECORD;
  operation "tool_budget_operation"%ROWTYPE;
BEGIN
  IF (p_subject_type IS NULL) IS DISTINCT FROM (p_subject_id IS NULL)
    OR (p_subject_type IS NOT NULL AND p_subject_type NOT IN ('contact', 'company', 'company_profile'))
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO loaded
  FROM load_tool_budget_result_unknown_artifact_v3(
    p_scope_key, p_operation_id, p_authority_id
  );
  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR SHARE;
  IF operation."expected_artifact_subject_type" IS DISTINCT FROM p_subject_type
    OR operation."expected_artifact_subject_id" IS DISTINCT FROM p_subject_id
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_subject_type IS NOT NULL AND EXISTS (
    SELECT 1 FROM "generic_operation_artifact_subject_tombstone" tombstone
    WHERE tombstone."workspace_id" = p_scope_key::UUID
      AND tombstone."subject_type" = p_subject_type
      AND tombstone."subject_id" = p_subject_id
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT loaded.expected_manifest,
    loaded.expected_http_status, loaded.expected_http_ok,
    loaded.expected_sanitized_url, loaded.expected_content_hash,
    loaded.expected_blocked_code, loaded.expected_robots_blocked;
END
$$;

-- append_workspace_generic_operation_artifact_v3: newest definition in 20260824110000; kinds widened.
CREATE OR REPLACE FUNCTION append_workspace_generic_operation_artifact_v3(
  p_workspace_id UUID, p_artifact_id UUID, p_authority_id UUID,
  p_operation_id UUID, p_result_schema TEXT, p_object_key TEXT,
  p_sha256 TEXT, p_size_bytes BIGINT, p_media_type TEXT,
  p_privacy_class TEXT, p_source_digest TEXT, p_created_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN, p_subject_type TEXT,
  p_subject_id UUID
)
RETURNS TABLE(
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3),
  expected_http_status SMALLINT, expected_http_ok BOOLEAN,
  expected_sanitized_url VARCHAR(2000), expected_content_hash CHAR(24),
  expected_blocked_code VARCHAR(80), expected_robots_blocked BOOLEAN,
  replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  was_existing BOOLEAN;
BEGIN
  IF (p_subject_type IS NULL) IS DISTINCT FROM (p_subject_id IS NULL)
    OR (p_privacy_class = 'PERSONAL_DATA') IS DISTINCT FROM
      (p_subject_type IS NOT NULL AND p_subject_id IS NOT NULL)
    OR (p_subject_type IS NOT NULL AND p_subject_type NOT IN ('contact', 'company', 'company_profile'))
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM "generic_operation_artifact" artifact
    WHERE artifact."scope_key" = p_workspace_id::text
      AND artifact."operation_id" = p_operation_id
  ) INTO was_existing;
  PERFORM * FROM append_workspace_generic_operation_artifact_v2(
    p_workspace_id, p_artifact_id, p_authority_id, p_operation_id,
    p_result_schema, p_object_key, p_sha256, p_size_bytes, p_media_type,
    p_privacy_class, p_source_digest, p_created_at, p_expires_at,
    p_expected_http_status, p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
  IF p_privacy_class = 'PERSONAL_DATA' THEN
    PERFORM * FROM bind_workspace_generic_operation_artifact_subject_v1(
      p_workspace_id, p_artifact_id, p_subject_type, p_subject_id
    );
  END IF;
  RETURN QUERY SELECT artifact."id", artifact."scope_key",
    artifact."workspace_id", artifact."authority_id",
    artifact."operation_id", artifact."result_schema",
    artifact."object_key", artifact."sha256", artifact."size_bytes",
    artifact."media_type", artifact."privacy_class",
    artifact."source_digest", artifact."created_at", artifact."expires_at",
    artifact."expected_http_status", artifact."expected_http_ok",
    artifact."expected_sanitized_url", artifact."expected_content_hash",
    artifact."expected_blocked_code", artifact."expected_robots_blocked",
    was_existing
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = p_workspace_id::text
    AND artifact."id" = p_artifact_id;
END
$$;

-- settle_tool_budget_artifact_manifest_v4: newest definition in 20260824110000; kinds widened.
CREATE OR REPLACE FUNCTION settle_tool_budget_artifact_manifest_v4(
  p_scope_key TEXT, p_operation_id UUID, p_observed_cents BIGINT,
  p_manifest JSONB, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN, p_subject_type TEXT,
  p_subject_id UUID
)
RETURNS TABLE(
  charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN,
  status TEXT, replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  settlement RECORD;
  artifact "generic_operation_artifact"%ROWTYPE;
  privacy_class TEXT := p_manifest->>'privacyClass';
BEGIN
  IF (p_subject_type IS NULL) IS DISTINCT FROM (p_subject_id IS NULL)
    OR (privacy_class = 'PERSONAL_DATA') IS DISTINCT FROM
      (p_subject_type IS NOT NULL AND p_subject_id IS NOT NULL)
    OR (p_subject_type IS NOT NULL AND p_subject_type NOT IN ('contact', 'company', 'company_profile'))
    OR (privacy_class = 'PERSONAL_DATA' AND p_scope_key = 'platform')
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO settlement
  FROM settle_tool_budget_artifact_manifest_v3(
    p_scope_key, p_operation_id, p_observed_cents, p_manifest,
    p_expected_http_status, p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
  SELECT target.* INTO artifact
  FROM "generic_operation_artifact" target
  WHERE target."scope_key" = p_scope_key
    AND target."operation_id" = p_operation_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF privacy_class = 'PERSONAL_DATA' THEN
    PERFORM * FROM bind_workspace_generic_operation_artifact_subject_v1(
      artifact."workspace_id", artifact."id", p_subject_type, p_subject_id
    );
  END IF;
  RETURN QUERY SELECT settlement.charged_cents,
    settlement.observed_cents, settlement.cap_variance,
    settlement.status, settlement.replay;
END
$$;

-- settle_tool_budget_artifact_manifest_with_receipt_v2: newest definition in 20260824120000; kinds widened.
CREATE OR REPLACE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v2(
  p_scope_key TEXT, p_operation_id UUID, p_observed_microusd BIGINT,
  p_manifest JSONB, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN, p_receipt_usage JSONB,
  p_receipt_cost_basis TEXT, p_subject_type TEXT, p_subject_id UUID
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
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  artifact "generic_operation_artifact"%ROWTYPE;
  appended RECORD;
  reference JSONB;
  charge BIGINT;
  replayed BOOLEAN := false;
  privacy_class TEXT := p_manifest->>'privacyClass';
  lock_account_key TEXT;
BEGIN
  PERFORM assert_execution_domain_ack_scope_v1(p_scope_key);
  PERFORM assert_generic_operation_artifact_expected_facts_v1(
    p_manifest->>'resultSchema', p_expected_http_status,
    p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
  IF (p_subject_type IS NULL) IS DISTINCT FROM (p_subject_id IS NULL)
    OR (privacy_class = 'PERSONAL_DATA') IS DISTINCT FROM
      (p_subject_type IS NOT NULL AND p_subject_id IS NOT NULL)
    OR (p_subject_type IS NOT NULL AND p_subject_type NOT IN ('contact','company','company_profile'))
    OR (privacy_class = 'PERSONAL_DATA' AND p_scope_key = 'platform')
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR NOT COALESCE((p_manifest->>'sha256') ~ '^[0-9a-f]{64}$', false)
    OR p_observed_microusd IS NULL OR p_observed_microusd < 0
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target."account_key" INTO lock_account_key
  FROM "tool_budget_operation" operation_key_source
  JOIN "tool_budget_account" target ON target."id"=operation_key_source."account_id"
  WHERE operation_key_source."id"=p_operation_id
    AND operation_key_source."scope_key"=p_scope_key;
  IF lock_account_key IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||lock_account_key,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-operation:'||p_scope_key||':'||p_operation_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-object:'||(p_manifest->>'sha256'),0));
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key"=p_scope_key AND target."id"=p_operation_id FOR UPDATE;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key AND target."id"=operation."account_id" FOR UPDATE;
  IF operation."id" IS NULL OR operation."amount_unit" <> 'microusd'
    OR account."id" IS NULL OR account."authority_id" IS NULL
    OR operation."generation" IS DISTINCT FROM account."generation"
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  PERFORM assert_generic_operation_artifact_manifest_v2(
    p_scope_key, operation."id", account."authority_id", p_manifest
  );
  reference := jsonb_build_object(
    'schemaVersion','generic-operation-artifact-ref/v1',
    'artifactId',p_manifest->>'artifactId','operationId',p_manifest->>'operationId',
    'resultSchema',p_manifest->>'resultSchema','sha256',p_manifest->>'sha256',
    'sizeBytes',p_manifest->>'sizeBytes','mediaType',p_manifest->>'mediaType',
    'expiresAt',p_manifest->>'expiresAt'
  );
  IF operation."status"='SETTLED' THEN
    IF operation."observed_microusd" IS DISTINCT FROM p_observed_microusd
      OR operation."result_json" IS DISTINCT FROM reference
      OR operation."result_digest" IS DISTINCT FROM p_manifest->>'sha256'
    THEN RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001'; END IF;
    replayed := true;
  ELSE
    IF operation."status" NOT IN ('RESERVED','RESULT_UNKNOWN') THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
    END IF;
    IF operation."status"='RESULT_UNKNOWN' AND (
      operation."expected_artifact" IS NULL
      OR operation."expected_artifact"->'manifest' IS DISTINCT FROM p_manifest
      OR operation."expected_artifact_subject_type" IS DISTINCT FROM p_subject_type
      OR operation."expected_artifact_subject_id" IS DISTINCT FROM p_subject_id
    ) THEN RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001'; END IF;
    SELECT * INTO appended FROM append_generic_operation_artifact_internal_v2(
      p_scope_key,(p_manifest->>'workspaceId')::UUID,
      (p_manifest->>'artifactId')::UUID,account."authority_id",operation."id",
      p_manifest->>'resultSchema',p_manifest->>'objectKey',p_manifest->>'sha256',
      (p_manifest->>'sizeBytes')::BIGINT,p_manifest->>'mediaType',privacy_class,
      p_manifest->>'sourceDigest',(p_manifest->>'createdAt')::TIMESTAMPTZ,
      (p_manifest->>'expiresAt')::TIMESTAMPTZ,p_expected_http_status,
      p_expected_http_ok,p_expected_sanitized_url,p_expected_content_hash,
      p_expected_blocked_code,p_expected_robots_blocked
    );
    IF appended.artifact_id IS NULL THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
    END IF;
    IF privacy_class='PERSONAL_DATA' THEN
      PERFORM * FROM bind_workspace_generic_operation_artifact_subject_v1(
        (p_manifest->>'workspaceId')::UUID,(p_manifest->>'artifactId')::UUID,
        p_subject_type,p_subject_id
      );
    END IF;
    charge := LEAST(p_observed_microusd, operation."reserved_microusd");
    UPDATE "tool_budget_operation" target SET
      "observed_microusd"=p_observed_microusd,"charged_microusd"=charge,
      "status"='SETTLED',"result_schema_version"='generic-operation-artifact-ref/v1',
      "result_schema"=p_manifest->>'resultSchema',"result_digest"=p_manifest->>'sha256',
      "result_json"=reference,"expected_http_status"=p_expected_http_status,
      "expected_http_ok"=p_expected_http_ok,"expected_sanitized_url"=p_expected_sanitized_url,
      "expected_content_hash"=p_expected_content_hash,"expected_blocked_code"=p_expected_blocked_code,
      "expected_robots_blocked"=p_expected_robots_blocked,"settled_at"=clock_timestamp()
    WHERE target."scope_key"=p_scope_key AND target."id"=p_operation_id
    RETURNING target.* INTO operation;
    UPDATE "tool_budget_account" target SET
      "reserved_microusd"=target."reserved_microusd"-operation."reserved_microusd",
      "charged_microusd"=target."charged_microusd"+charge,
      "exhausted"=target."exhausted" OR p_observed_microusd>operation."reserved_microusd",
      "updated_at"=clock_timestamp()
    WHERE target."scope_key"=p_scope_key AND target."id"=account."id";
  END IF;
  PERFORM execution_receipt_store_facts_v1(
    p_scope_key,p_operation_id,p_receipt_usage,p_receipt_cost_basis,NOT replayed
  );
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key"=p_scope_key AND target."id"=p_operation_id FOR UPDATE;
  SELECT target.* INTO artifact FROM "generic_operation_artifact" target
  WHERE target."scope_key"=p_scope_key AND target."operation_id"=p_operation_id FOR SHARE;
  IF artifact."id" IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT operation."charged_microusd",operation."observed_microusd",
    operation."observed_microusd">operation."reserved_microusd",
    operation."status"::text,replayed,operation."reserved_microusd",operation."id",
    operation."operation_key"::TEXT,account."id",account."authority_id",
    operation."result_schema_version"::TEXT,operation."result_schema"::TEXT,
    operation."result_digest"::TEXT,operation."result_json",operation."receipt_usage",
    operation."receipt_cost_basis"::TEXT;
END
$$;

-- A seller profile cannot be deleted while an artifact is bound to it and its subject has no
-- tombstone. AFTER, so a delete that waited on the key-share lock a concurrent binding holds
-- (assert above) re-reads the subject rows once that binding has committed.
CREATE FUNCTION guard_company_profile_artifact_subject_delete_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "generic_operation_artifact_subject" subject
    WHERE subject."workspace_id" = OLD."workspace_id"
      AND subject."subject_type" = 'company_profile'
      AND subject."subject_id" = OLD."id"
  ) AND NOT EXISTS (
    SELECT 1 FROM "generic_operation_artifact_subject_tombstone" tombstone
    WHERE tombstone."workspace_id" = OLD."workspace_id"
      AND tombstone."subject_type" = 'company_profile'
      AND tombstone."subject_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_NOT_TOMBSTONED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "company_profile_artifact_subject_delete_guard"
AFTER DELETE ON "company_profile"
FOR EACH ROW
EXECUTE FUNCTION guard_company_profile_artifact_subject_delete_v1();

REVOKE ALL ON FUNCTION guard_company_profile_artifact_subject_delete_v1()
FROM PUBLIC, app_user, execution_budget_platform_writer;

COMMIT;
