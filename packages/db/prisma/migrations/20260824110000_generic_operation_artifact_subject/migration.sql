BEGIN;

-- PERSONAL_DATA artifacts are not physically wired on this cutover base. If
-- retained data appears before this additive migration, its exact DSR subject
-- provenance is unknown and must be reconciled explicitly rather than guessed
-- from body bytes, authority purpose, email or name.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "generic_operation_artifact"
    WHERE "privacy_class" = 'PERSONAL_DATA'
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_PROVENANCE_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "tool_budget_operation"
    WHERE "expected_artifact"->'manifest'->>'privacyClass' = 'PERSONAL_DATA'
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_PROVENANCE_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
END
$guard$;

ALTER TABLE "tool_budget_operation"
  ADD COLUMN "expected_artifact_subject_type" VARCHAR(16),
  ADD COLUMN "expected_artifact_subject_id" UUID,
  ADD CONSTRAINT "tool_budget_operation_expected_artifact_subject_check"
  CHECK (
    ("expected_artifact_subject_type" IS NULL) =
      ("expected_artifact_subject_id" IS NULL)
    AND (
      "expected_artifact_subject_type" IS NULL
      OR "expected_artifact_subject_type" IN ('contact', 'company')
    )
  );

CREATE TABLE "generic_operation_artifact_subject" (
  "artifact_id" UUID NOT NULL,
  "scope_key" VARCHAR(200) NOT NULL,
  "workspace_id" UUID NOT NULL,
  "subject_type" VARCHAR(16) NOT NULL,
  "subject_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generic_operation_artifact_subject_pkey"
    PRIMARY KEY ("artifact_id"),
  CONSTRAINT "generic_operation_artifact_subject_scope_id_key"
    UNIQUE ("scope_key", "artifact_id"),
  CONSTRAINT "generic_operation_artifact_subject_type_check"
    CHECK ("subject_type" IN ('contact', 'company')),
  CONSTRAINT "generic_operation_artifact_subject_scope_check"
    CHECK ("scope_key" = "workspace_id"::text),
  CONSTRAINT "generic_operation_artifact_subject_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "generic_operation_artifact_subject_artifact_scope_fkey"
    FOREIGN KEY ("scope_key", "artifact_id")
    REFERENCES "generic_operation_artifact"("scope_key", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "generic_operation_artifact_subject_lookup_idx"
  ON "generic_operation_artifact_subject"(
    "workspace_id", "subject_type", "subject_id", "artifact_id"
  );

CREATE TABLE "generic_operation_artifact_subject_tombstone" (
  "workspace_id" UUID NOT NULL,
  "subject_type" VARCHAR(16) NOT NULL,
  "subject_id" UUID NOT NULL,
  "tombstoned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generic_operation_artifact_subject_tombstone_pkey"
    PRIMARY KEY ("workspace_id", "subject_type", "subject_id"),
  CONSTRAINT "generic_operation_artifact_subject_tombstone_type_check"
    CHECK ("subject_type" IN ('contact', 'company')),
  CONSTRAINT "generic_operation_artifact_subject_tombstone_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "generic_operation_artifact_subject_tombstone_time_idx"
  ON "generic_operation_artifact_subject_tombstone"(
    "workspace_id", "tombstoned_at"
  );

CREATE TABLE "generic_operation_artifact_subject_tombstone_audit" (
  "deletion_request_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "subject_type" VARCHAR(16) NOT NULL,
  "subject_id" UUID NOT NULL,
  "tombstoned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generic_operation_artifact_subject_tombstone_audit_pkey"
    PRIMARY KEY ("deletion_request_id"),
  CONSTRAINT "generic_operation_artifact_subject_tombstone_audit_type_check"
    CHECK ("subject_type" IN ('contact', 'company')),
  CONSTRAINT "goa_subject_tombstone_audit_request_fkey"
    FOREIGN KEY ("deletion_request_id") REFERENCES "deletion_request"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "goa_subject_tombstone_audit_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "goa_subject_tombstone_audit_subject_fkey"
    FOREIGN KEY ("workspace_id", "subject_type", "subject_id")
    REFERENCES "generic_operation_artifact_subject_tombstone"(
      "workspace_id", "subject_type", "subject_id"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "generic_operation_artifact_subject_tombstone_audit_subject_idx"
  ON "generic_operation_artifact_subject_tombstone_audit"(
    "workspace_id", "subject_type", "subject_id", "tombstoned_at"
  );

ALTER TABLE "generic_operation_artifact_subject"
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generic_operation_artifact_subject"
  FORCE ROW LEVEL SECURITY;
CREATE POLICY "generic_operation_artifact_subject_scope_isolation"
  ON "generic_operation_artifact_subject"
  USING (
    session_user = 'app_user'
    AND current_setting('role', true) IS NOT DISTINCT FROM 'none'
    AND "workspace_id" IS NOT DISTINCT FROM current_workspace_id()
    AND "scope_key" = current_workspace_id()::text
  )
  WITH CHECK (
    session_user = 'app_user'
    AND current_setting('role', true) IS NOT DISTINCT FROM 'none'
    AND "workspace_id" IS NOT DISTINCT FROM current_workspace_id()
    AND "scope_key" = current_workspace_id()::text
  );

ALTER TABLE "generic_operation_artifact_subject_tombstone"
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generic_operation_artifact_subject_tombstone"
  FORCE ROW LEVEL SECURITY;
CREATE POLICY "generic_operation_artifact_subject_tombstone_scope_isolation"
  ON "generic_operation_artifact_subject_tombstone"
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

ALTER TABLE "generic_operation_artifact_subject_tombstone_audit"
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generic_operation_artifact_subject_tombstone_audit"
  FORCE ROW LEVEL SECURITY;
CREATE POLICY "generic_operation_artifact_subject_tombstone_audit_scope_isolation"
  ON "generic_operation_artifact_subject_tombstone_audit"
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

CREATE FUNCTION assert_workspace_generic_operation_artifact_subject_v1(
  p_workspace_id UUID, p_subject_type TEXT, p_subject_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
    OR p_subject_type NOT IN ('contact', 'company')
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
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

CREATE FUNCTION bind_workspace_generic_operation_artifact_subject_v1(
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
    OR p_subject_type NOT IN ('contact', 'company')
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

CREATE FUNCTION find_workspace_generic_operation_artifacts_by_subject_v1(
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
    OR p_subject_type NOT IN ('contact', 'company')
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

CREATE FUNCTION tombstone_workspace_generic_operation_artifact_subject_v1(
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
    OR p_subject_type NOT IN ('contact', 'company')
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

CREATE FUNCTION enforce_generic_operation_artifact_personal_subject_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_artifact "generic_operation_artifact"%ROWTYPE;
  current_operation "tool_budget_operation"%ROWTYPE;
BEGIN
  SELECT target.* INTO current_artifact
  FROM "generic_operation_artifact" target
  WHERE target."scope_key" = NEW."scope_key"
    AND target."id" = NEW."id";
  SELECT target.* INTO current_operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = current_artifact."scope_key"
    AND target."id" = current_artifact."operation_id";
  IF current_artifact."privacy_class" = 'PERSONAL_DATA' AND NOT EXISTS (
    SELECT 1 FROM "generic_operation_artifact_subject" subject
    WHERE subject."scope_key" = current_artifact."scope_key"
      AND subject."artifact_id" = current_artifact."id"
      AND subject."workspace_id" IS NOT DISTINCT FROM current_artifact."workspace_id"
      AND (
        current_operation."expected_artifact" IS NULL
        OR (
          subject."subject_type" IS NOT DISTINCT FROM
            current_operation."expected_artifact_subject_type"
          AND subject."subject_id" IS NOT DISTINCT FROM
            current_operation."expected_artifact_subject_id"
        )
      )
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER "generic_operation_artifact_personal_subject_guard"
AFTER INSERT OR UPDATE OF "privacy_class" ON "generic_operation_artifact"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_generic_operation_artifact_personal_subject_v1();

CREATE FUNCTION enforce_tool_budget_expected_artifact_subject_v1()
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
      OR current_operation."expected_artifact_subject_type" NOT IN ('contact', 'company')
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
CREATE CONSTRAINT TRIGGER "tool_budget_expected_artifact_subject_guard"
AFTER INSERT OR UPDATE OF "expected_artifact",
  "expected_artifact_subject_type", "expected_artifact_subject_id"
ON "tool_budget_operation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_tool_budget_expected_artifact_subject_v1();

CREATE FUNCTION mark_tool_budget_result_unknown_v4(
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
    OR (has_subject AND p_subject_type NOT IN ('contact', 'company'))
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

CREATE FUNCTION load_tool_budget_result_unknown_artifact_v4(
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
    OR (p_subject_type IS NOT NULL AND p_subject_type NOT IN ('contact', 'company'))
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

CREATE FUNCTION append_workspace_generic_operation_artifact_v3(
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
    OR (p_subject_type IS NOT NULL AND p_subject_type NOT IN ('contact', 'company'))
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

CREATE FUNCTION settle_tool_budget_artifact_manifest_v4(
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
    OR (p_subject_type IS NOT NULL AND p_subject_type NOT IN ('contact', 'company'))
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

-- Raw workspace lookup remains the v2 API, but a subject tombstone makes every
-- manifest for that exact workspace/subject indistinguishably absent. Domain
-- ACK state is separate and is never modified here.
CREATE OR REPLACE FUNCTION find_exact_workspace_generic_operation_artifact_v2(
  p_workspace_id UUID, p_artifact_id UUID, p_authority_id UUID,
  p_operation_id UUID, p_result_schema TEXT, p_sha256 TEXT,
  p_size_bytes BIGINT, p_media_type TEXT, p_expires_at TIMESTAMPTZ
)
RETURNS TABLE(
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3),
  expected_http_status SMALLINT, expected_http_ok BOOLEAN,
  expected_sanitized_url VARCHAR(2000), expected_content_hash CHAR(24),
  expected_blocked_code VARCHAR(80), expected_robots_blocked BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY SELECT
    base.artifact_id, base.scope_key, base.workspace_id, base.authority_id,
    base.operation_id, base.result_schema, base.object_key, base.sha256,
    base.size_bytes, base.media_type, base.privacy_class,
    base.source_digest, base.created_at, base.expires_at,
    artifact."expected_http_status", artifact."expected_http_ok",
    artifact."expected_sanitized_url", artifact."expected_content_hash",
    artifact."expected_blocked_code", artifact."expected_robots_blocked"
  FROM find_exact_workspace_generic_operation_artifact_v1(
    p_workspace_id, p_artifact_id, p_authority_id, p_operation_id,
    p_result_schema, p_sha256, p_size_bytes, p_media_type, p_expires_at
  ) base
  JOIN "generic_operation_artifact" artifact
    ON artifact."scope_key" = base.scope_key
   AND artifact."id" = base.artifact_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact_subject_tombstone" tombstone
      ON tombstone."workspace_id" = subject."workspace_id"
     AND tombstone."subject_type" = subject."subject_type"
     AND tombstone."subject_id" = subject."subject_id"
    WHERE subject."scope_key" = artifact."scope_key"
      AND subject."artifact_id" = artifact."id"
  );
END
$$;

CREATE OR REPLACE FUNCTION find_workspace_generic_operation_artifact_by_operation_v2(
  p_workspace_id UUID, p_authority_id UUID, p_operation_id UUID,
  p_result_schema TEXT
)
RETURNS TABLE(
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3),
  expected_http_status SMALLINT, expected_http_ok BOOLEAN,
  expected_sanitized_url VARCHAR(2000), expected_content_hash CHAR(24),
  expected_blocked_code VARCHAR(80), expected_robots_blocked BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY SELECT
    base.artifact_id, base.scope_key, base.workspace_id, base.authority_id,
    base.operation_id, base.result_schema, base.object_key, base.sha256,
    base.size_bytes, base.media_type, base.privacy_class,
    base.source_digest, base.created_at, base.expires_at,
    artifact."expected_http_status", artifact."expected_http_ok",
    artifact."expected_sanitized_url", artifact."expected_content_hash",
    artifact."expected_blocked_code", artifact."expected_robots_blocked"
  FROM find_workspace_generic_operation_artifact_by_operation_v1(
    p_workspace_id, p_authority_id, p_operation_id, p_result_schema
  ) base
  JOIN "generic_operation_artifact" artifact
    ON artifact."scope_key" = base.scope_key
   AND artifact."id" = base.artifact_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact_subject_tombstone" tombstone
      ON tombstone."workspace_id" = subject."workspace_id"
     AND tombstone."subject_type" = subject."subject_type"
     AND tombstone."subject_id" = subject."subject_id"
    WHERE subject."scope_key" = artifact."scope_key"
      AND subject."artifact_id" = artifact."id"
  );
END
$$;

-- Explicit pg_temp-last hardening for every predecessor reached by a new
-- SECURITY DEFINER wrapper. Without an explicit pg_temp entry PostgreSQL may
-- search the caller's temporary schema before public for unqualified names.
ALTER FUNCTION append_generic_operation_artifact_internal_v1(
  TEXT, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
  TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION append_workspace_generic_operation_artifact_v1(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION append_platform_generic_operation_artifact_v1(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION append_generic_operation_artifact_internal_v2(
  TEXT, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
  TEXT, TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT,
  BOOLEAN
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION append_workspace_generic_operation_artifact_v2(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION append_platform_generic_operation_artifact_v2(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION find_exact_workspace_generic_operation_artifact_v1(
  UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION find_workspace_generic_operation_artifact_by_operation_v1(
  UUID, UUID, UUID, TEXT
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION find_exact_platform_generic_operation_artifact_v1(
  UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION find_platform_generic_operation_artifact_by_operation_v1(
  UUID, UUID, TEXT
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION find_exact_platform_generic_operation_artifact_v2(
  UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION find_platform_generic_operation_artifact_by_operation_v2(
  UUID, UUID, TEXT
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION mark_tool_budget_result_unknown_v2(
  TEXT, UUID, JSONB
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION load_tool_budget_result_unknown_artifact_v2(
  TEXT, UUID, UUID
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION settle_tool_budget_artifact_manifest_v2(
  TEXT, UUID, BIGINT, JSONB
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION mark_tool_budget_result_unknown_v3(
  TEXT, UUID, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION load_tool_budget_result_unknown_artifact_v3(
  TEXT, UUID, UUID
) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION settle_tool_budget_artifact_manifest_v3(
  TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) SET search_path TO pg_catalog, public, pg_temp;

REVOKE ALL ON TABLE
  "generic_operation_artifact_subject",
  "generic_operation_artifact_subject_tombstone",
  "generic_operation_artifact_subject_tombstone_audit"
FROM PUBLIC, app_user, execution_budget_platform_writer;
REVOKE ALL ON FUNCTION
  assert_workspace_generic_operation_artifact_subject_v1(UUID, TEXT, UUID),
  bind_workspace_generic_operation_artifact_subject_v1(UUID, UUID, TEXT, UUID),
  find_workspace_generic_operation_artifacts_by_subject_v1(UUID, TEXT, UUID),
  tombstone_workspace_generic_operation_artifact_subject_v1(UUID, TEXT, UUID, UUID),
  enforce_generic_operation_artifact_personal_subject_v1(),
  enforce_tool_budget_expected_artifact_subject_v1(),
  mark_tool_budget_result_unknown_v4(TEXT, UUID, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN, TEXT, UUID),
  load_tool_budget_result_unknown_artifact_v4(TEXT, UUID, UUID, TEXT, UUID),
  append_workspace_generic_operation_artifact_v3(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN, TEXT, UUID),
  settle_tool_budget_artifact_manifest_v4(TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN, TEXT, UUID)
FROM PUBLIC, app_user, execution_budget_platform_writer;
-- v1 workspace reads predate subject tombstones and would disclose a
-- tombstoned manifest/object key. v2 remains the sole app-role read surface;
-- its SECURITY DEFINER body can call the owner-owned v1 helper internally.
REVOKE EXECUTE ON FUNCTION
  find_exact_workspace_generic_operation_artifact_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ),
  find_workspace_generic_operation_artifact_by_operation_v1(UUID, UUID, UUID, TEXT)
FROM app_user;
-- The predecessor RESULT_UNKNOWN APIs do not carry a subject binding. Keep
-- them owner-internal for v4 wrappers and close every direct app/platform path.
REVOKE EXECUTE ON FUNCTION
  mark_tool_budget_result_unknown_v2(TEXT, UUID, JSONB),
  load_tool_budget_result_unknown_artifact_v2(TEXT, UUID, UUID),
  mark_tool_budget_result_unknown_v3(TEXT, UUID, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  load_tool_budget_result_unknown_artifact_v3(TEXT, UUID, UUID)
FROM app_user, execution_budget_platform_writer;
REVOKE EXECUTE ON FUNCTION
  settle_tool_budget_artifact_manifest_v2(TEXT, UUID, BIGINT, JSONB),
  settle_tool_budget_artifact_manifest_v3(TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN)
FROM app_user, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION
  bind_workspace_generic_operation_artifact_subject_v1(UUID, UUID, TEXT, UUID),
  find_workspace_generic_operation_artifacts_by_subject_v1(UUID, TEXT, UUID),
  tombstone_workspace_generic_operation_artifact_subject_v1(UUID, TEXT, UUID, UUID),
  mark_tool_budget_result_unknown_v4(TEXT, UUID, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN, TEXT, UUID),
  load_tool_budget_result_unknown_artifact_v4(TEXT, UUID, UUID, TEXT, UUID),
  append_workspace_generic_operation_artifact_v3(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN, TEXT, UUID),
  settle_tool_budget_artifact_manifest_v4(TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN, TEXT, UUID)
TO app_user;
GRANT EXECUTE ON FUNCTION
  mark_tool_budget_result_unknown_v4(TEXT, UUID, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN, TEXT, UUID),
  load_tool_budget_result_unknown_artifact_v4(TEXT, UUID, UUID, TEXT, UUID),
  settle_tool_budget_artifact_manifest_v4(TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN, TEXT, UUID)
TO execution_budget_platform_writer;

COMMIT;
