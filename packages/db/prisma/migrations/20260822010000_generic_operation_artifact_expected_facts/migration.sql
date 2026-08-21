BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;
CREATE FUNCTION generic_operation_artifact_sanitized_url_valid_v1(p_url TEXT)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(char_length(p_url) BETWEEN 1 AND 2000
    AND p_url ~ '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/[a-z0-9._~!$&''()*+,;=:/-]*$'
    AND split_part(split_part(p_url, '://', 2), '/', 1) ~ '[a-z]'
    AND p_url !~ '/\.{1,2}(/|$)'
    AND char_length(regexp_replace(p_url, '[^0-9]', '', 'g')) < 9, false)
$$;
CREATE FUNCTION generic_operation_artifact_expected_facts_valid_v1(
  p_result_schema TEXT, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN
)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(CASE p_result_schema
    WHEN 'sanctions-download/v1' THEN
      p_expected_http_status IS NULL
      AND p_expected_http_ok IS NULL
      AND p_expected_sanitized_url IS NULL
      AND p_expected_content_hash IS NULL
      AND p_expected_blocked_code IS NULL
      AND p_expected_robots_blocked IS NULL
    WHEN 'http-get/v1' THEN
      p_expected_http_status IS NOT NULL
      AND p_expected_http_ok IS NOT NULL
      AND p_expected_content_hash IS NULL
      AND p_expected_robots_blocked IS NULL
      AND COALESCE((
        p_expected_http_status = 0
        AND p_expected_http_ok = false
        AND p_expected_sanitized_url IS NULL
        AND p_expected_blocked_code ~ '^[a-z][a-z0-9_]{0,79}$'
      ) OR (
        p_expected_http_status BETWEEN 100 AND 599
        AND p_expected_http_ok = (p_expected_http_status BETWEEN 200 AND 299)
        AND p_expected_blocked_code IS NULL
        AND generic_operation_artifact_sanitized_url_valid_v1(
          p_expected_sanitized_url
        )
      ), false)
    WHEN 'crawl4ai-fetch/v1' THEN
      p_expected_http_status IS NULL
      AND p_expected_http_ok IS NULL
      AND p_expected_blocked_code IS NULL
      AND p_expected_robots_blocked IS NULL
      AND generic_operation_artifact_sanitized_url_valid_v1(
        p_expected_sanitized_url
      )
      AND p_expected_content_hash ~ '^[0-9a-f]{24}$'
    WHEN 'crawl4ai-render/v1' THEN
      p_expected_http_status IS NULL
      AND p_expected_http_ok IS NULL
      AND p_expected_content_hash IS NULL
      AND p_expected_blocked_code IS NULL
      AND p_expected_robots_blocked IS NOT NULL
      AND generic_operation_artifact_sanitized_url_valid_v1(
        p_expected_sanitized_url
      )
    ELSE false
  END, false)
$$;
CREATE FUNCTION assert_generic_operation_artifact_expected_facts_v1(
  p_result_schema TEXT, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT generic_operation_artifact_expected_facts_valid_v1(
    p_result_schema, p_expected_http_status, p_expected_http_ok,
    p_expected_sanitized_url, p_expected_content_hash,
    p_expected_blocked_code, p_expected_robots_blocked
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;
CREATE FUNCTION enforce_generic_operation_artifact_expected_facts_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_artifact "generic_operation_artifact"%ROWTYPE;
BEGIN
  -- Query the current row at deferred execution time. The v2 append inserts
  -- then binds typed facts in one transaction; a predecessor append that
  -- leaves a new non-sanctions row nullable therefore fails at COMMIT.
  SELECT artifact.* INTO current_artifact
  FROM "generic_operation_artifact" artifact
  WHERE artifact."id" = NEW."id";
  IF current_artifact."id" IS NOT NULL THEN
    PERFORM assert_generic_operation_artifact_expected_facts_v1(
      current_artifact."result_schema",
      current_artifact."expected_http_status",
      current_artifact."expected_http_ok",
      current_artifact."expected_sanitized_url",
      current_artifact."expected_content_hash",
      current_artifact."expected_blocked_code",
      current_artifact."expected_robots_blocked"
    );
  END IF;
  RETURN NULL;
END
$$;
CREATE FUNCTION enforce_tool_budget_operation_expected_facts_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
  result_schema TEXT;
BEGIN
  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."id" = NEW."id";
  result_schema := COALESCE(
    operation."result_schema",
    operation."expected_artifact"->'manifest'->>'resultSchema'
  );
  IF operation."status" IN ('RESULT_UNKNOWN', 'SETTLED')
    AND result_schema IN (
      'sanctions-download/v1', 'http-get/v1',
      'crawl4ai-fetch/v1', 'crawl4ai-render/v1'
    )
    AND (
      operation."status" = 'SETTLED'
      OR operation."expected_artifact" IS NOT NULL
    )
  THEN
    PERFORM assert_generic_operation_artifact_expected_facts_v1(
      result_schema, operation."expected_http_status",
      operation."expected_http_ok", operation."expected_sanitized_url",
      operation."expected_content_hash", operation."expected_blocked_code",
      operation."expected_robots_blocked"
    );
  END IF;
  RETURN NULL;
END
$$;
CREATE FUNCTION append_generic_operation_artifact_internal_v2(
  p_scope_key TEXT,
  p_workspace_id UUID,
  p_artifact_id UUID,
  p_authority_id UUID,
  p_operation_id UUID,
  p_result_schema TEXT,
  p_object_key TEXT,
  p_sha256 TEXT,
  p_size_bytes BIGINT,
  p_media_type TEXT,
  p_privacy_class TEXT,
  p_source_digest TEXT,
  p_created_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ,
  p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN,
  p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT,
  p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  appended RECORD;
  stored "generic_operation_artifact"%ROWTYPE;
BEGIN
  PERFORM assert_generic_operation_artifact_expected_facts_v1(
    p_result_schema, p_expected_http_status, p_expected_http_ok,
    p_expected_sanitized_url, p_expected_content_hash,
    p_expected_blocked_code, p_expected_robots_blocked
  );
  SELECT * INTO appended
  FROM append_generic_operation_artifact_internal_v1(
    p_scope_key, p_workspace_id, p_artifact_id, p_authority_id,
    p_operation_id, p_result_schema, p_object_key, p_sha256, p_size_bytes,
    p_media_type, p_privacy_class, p_source_digest, p_created_at, p_expires_at
  );
  SELECT artifact.* INTO stored
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = p_scope_key
    AND artifact."operation_id" = p_operation_id
  FOR UPDATE;
  IF appended.replay THEN
    IF stored."expected_http_status" IS DISTINCT FROM p_expected_http_status
      OR stored."expected_http_ok" IS DISTINCT FROM p_expected_http_ok
      OR stored."expected_sanitized_url"
        IS DISTINCT FROM p_expected_sanitized_url
      OR stored."expected_content_hash"
        IS DISTINCT FROM p_expected_content_hash
      OR stored."expected_blocked_code"
        IS DISTINCT FROM p_expected_blocked_code
      OR stored."expected_robots_blocked"
        IS DISTINCT FROM p_expected_robots_blocked
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    UPDATE "generic_operation_artifact" artifact
    SET "expected_http_status" = p_expected_http_status,
        "expected_http_ok" = p_expected_http_ok,
        "expected_sanitized_url" = p_expected_sanitized_url,
        "expected_content_hash" = p_expected_content_hash,
        "expected_blocked_code" = p_expected_blocked_code,
        "expected_robots_blocked" = p_expected_robots_blocked
    WHERE artifact."scope_key" = p_scope_key
      AND artifact."operation_id" = p_operation_id
    RETURNING artifact.* INTO stored;
  END IF;
  RETURN QUERY SELECT
    stored."id", stored."scope_key", stored."workspace_id",
    stored."authority_id", stored."operation_id", stored."result_schema",
    stored."object_key", stored."sha256", stored."size_bytes",
    stored."media_type", stored."privacy_class", stored."source_digest",
    stored."created_at", stored."expires_at",
    stored."expected_http_status", stored."expected_http_ok",
    stored."expected_sanitized_url", stored."expected_content_hash",
    stored."expected_blocked_code", stored."expected_robots_blocked",
    appended.replay;
END
$$;
CREATE FUNCTION append_workspace_generic_operation_artifact_v2(
  p_workspace_id UUID, p_artifact_id UUID, p_authority_id UUID,
  p_operation_id UUID, p_result_schema TEXT, p_object_key TEXT,
  p_sha256 TEXT, p_size_bytes BIGINT, p_media_type TEXT,
  p_privacy_class TEXT, p_source_digest TEXT, p_created_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN
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
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT *
  FROM append_generic_operation_artifact_internal_v2(
    p_workspace_id::text, p_workspace_id, p_artifact_id, p_authority_id,
    p_operation_id, p_result_schema, p_object_key, p_sha256, p_size_bytes,
    p_media_type, p_privacy_class, p_source_digest, p_created_at, p_expires_at,
    p_expected_http_status, p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
END
$$;
CREATE FUNCTION append_platform_generic_operation_artifact_v2(
  p_artifact_id UUID, p_authority_id UUID, p_operation_id UUID,
  p_result_schema TEXT, p_object_key TEXT, p_sha256 TEXT,
  p_size_bytes BIGINT, p_media_type TEXT, p_privacy_class TEXT,
  p_source_digest TEXT, p_created_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN
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
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  RETURN QUERY SELECT *
  FROM append_generic_operation_artifact_internal_v2(
    'platform', NULL, p_artifact_id, p_authority_id, p_operation_id,
    p_result_schema, p_object_key, p_sha256, p_size_bytes, p_media_type,
    p_privacy_class, p_source_digest, p_created_at, p_expires_at,
    p_expected_http_status, p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
END
$$;
CREATE FUNCTION find_exact_workspace_generic_operation_artifact_v2(
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
SET search_path = pg_catalog, public
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
   AND artifact."id" = base.artifact_id;
END
$$;
CREATE FUNCTION find_exact_platform_generic_operation_artifact_v2(
  p_artifact_id UUID, p_authority_id UUID, p_operation_id UUID,
  p_result_schema TEXT, p_sha256 TEXT, p_size_bytes BIGINT,
  p_media_type TEXT, p_expires_at TIMESTAMPTZ
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
SET search_path = pg_catalog, public
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
  FROM find_exact_platform_generic_operation_artifact_v1(
    p_artifact_id, p_authority_id, p_operation_id, p_result_schema,
    p_sha256, p_size_bytes, p_media_type, p_expires_at
  ) base
  JOIN "generic_operation_artifact" artifact
    ON artifact."scope_key" = base.scope_key
   AND artifact."id" = base.artifact_id;
END
$$;
CREATE FUNCTION find_workspace_generic_operation_artifact_by_operation_v2(
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
SET search_path = pg_catalog, public
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
   AND artifact."id" = base.artifact_id;
END
$$;
CREATE FUNCTION find_platform_generic_operation_artifact_by_operation_v2(
  p_authority_id UUID, p_operation_id UUID, p_result_schema TEXT
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
SET search_path = pg_catalog, public
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
  FROM find_platform_generic_operation_artifact_by_operation_v1(
    p_authority_id, p_operation_id, p_result_schema
  ) base
  JOIN "generic_operation_artifact" artifact
    ON artifact."scope_key" = base.scope_key
   AND artifact."id" = base.artifact_id;
END
$$;
CREATE FUNCTION mark_tool_budget_result_unknown_v3(
  p_scope_key TEXT, p_operation_id UUID, p_expected_manifest JSONB,
  p_expected_http_status SMALLINT, p_expected_http_ok BOOLEAN,
  p_expected_sanitized_url TEXT, p_expected_content_hash TEXT,
  p_expected_blocked_code TEXT, p_expected_robots_blocked BOOLEAN
)
RETURNS TABLE(
  reserved_cents BIGINT, status TEXT, replay BOOLEAN, recoverable BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  transition RECORD;
  operation "tool_budget_operation"%ROWTYPE;
BEGIN
  IF p_expected_manifest IS NULL THEN
    IF p_expected_http_status IS NOT NULL
      OR p_expected_http_ok IS NOT NULL
      OR p_expected_sanitized_url IS NOT NULL
      OR p_expected_content_hash IS NOT NULL
      OR p_expected_blocked_code IS NOT NULL
      OR p_expected_robots_blocked IS NOT NULL
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    PERFORM assert_generic_operation_artifact_expected_facts_v1(
      p_expected_manifest->>'resultSchema', p_expected_http_status,
      p_expected_http_ok, p_expected_sanitized_url,
      p_expected_content_hash, p_expected_blocked_code,
      p_expected_robots_blocked
    );
  END IF;
  SELECT * INTO transition
  FROM mark_tool_budget_result_unknown_v2(
    p_scope_key, p_operation_id, p_expected_manifest
  );
  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR UPDATE;
  IF transition.replay THEN
    IF operation."expected_http_status"
        IS DISTINCT FROM p_expected_http_status
      OR operation."expected_http_ok" IS DISTINCT FROM p_expected_http_ok
      OR operation."expected_sanitized_url"
        IS DISTINCT FROM p_expected_sanitized_url
      OR operation."expected_content_hash"
        IS DISTINCT FROM p_expected_content_hash
      OR operation."expected_blocked_code"
        IS DISTINCT FROM p_expected_blocked_code
      OR operation."expected_robots_blocked"
        IS DISTINCT FROM p_expected_robots_blocked
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    UPDATE "tool_budget_operation" target
    SET "expected_http_status" = p_expected_http_status,
        "expected_http_ok" = p_expected_http_ok,
        "expected_sanitized_url" = p_expected_sanitized_url,
        "expected_content_hash" = p_expected_content_hash,
        "expected_blocked_code" = p_expected_blocked_code,
        "expected_robots_blocked" = p_expected_robots_blocked
    WHERE target."scope_key" = p_scope_key
      AND target."id" = p_operation_id;
  END IF;
  RETURN QUERY SELECT transition.reserved_cents, transition.status,
    transition.replay, transition.recoverable;
END
$$;
CREATE FUNCTION load_tool_budget_result_unknown_artifact_v3(
  p_scope_key TEXT, p_operation_id UUID, p_authority_id UUID
)
RETURNS TABLE(
  expected_manifest JSONB, expected_http_status SMALLINT,
  expected_http_ok BOOLEAN, expected_sanitized_url VARCHAR(2000),
  expected_content_hash CHAR(24), expected_blocked_code VARCHAR(80),
  expected_robots_blocked BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  loaded RECORD;
  operation "tool_budget_operation"%ROWTYPE;
BEGIN
  SELECT * INTO loaded
  FROM load_tool_budget_result_unknown_artifact_v2(
    p_scope_key, p_operation_id, p_authority_id
  );
  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR SHARE;
  PERFORM assert_generic_operation_artifact_expected_facts_v1(
    loaded.expected_manifest->>'resultSchema',
    operation."expected_http_status", operation."expected_http_ok",
    operation."expected_sanitized_url", operation."expected_content_hash",
    operation."expected_blocked_code", operation."expected_robots_blocked"
  );
  RETURN QUERY SELECT loaded.expected_manifest,
    operation."expected_http_status", operation."expected_http_ok",
    operation."expected_sanitized_url", operation."expected_content_hash",
    operation."expected_blocked_code", operation."expected_robots_blocked";
END
$$;
CREATE FUNCTION settle_tool_budget_artifact_manifest_v3(
  p_scope_key TEXT, p_operation_id UUID, p_observed_cents BIGINT,
  p_manifest JSONB, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN
)
RETURNS TABLE(
  charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN,
  status TEXT, replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  settlement RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  artifact "generic_operation_artifact"%ROWTYPE;
BEGIN
  PERFORM assert_generic_operation_artifact_expected_facts_v1(
    p_manifest->>'resultSchema', p_expected_http_status,
    p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
  -- Preserve the predecessor lock order: v2 acquires operation/object advisory
  -- locks before operation/account row locks. All fact comparisons remain in
  -- this transaction and roll the v2 settlement back on mismatch.
  SELECT * INTO settlement
  FROM settle_tool_budget_artifact_manifest_v2(
    p_scope_key, p_operation_id, p_observed_cents, p_manifest
  );
  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR UPDATE;
  SELECT target.* INTO artifact
  FROM "generic_operation_artifact" target
  WHERE target."scope_key" = p_scope_key
    AND target."operation_id" = p_operation_id
  FOR UPDATE;
  IF operation."expected_artifact" IS NOT NULL
    AND (
      operation."expected_http_status"
        IS DISTINCT FROM p_expected_http_status
      OR operation."expected_http_ok" IS DISTINCT FROM p_expected_http_ok
      OR operation."expected_sanitized_url"
        IS DISTINCT FROM p_expected_sanitized_url
      OR operation."expected_content_hash"
        IS DISTINCT FROM p_expected_content_hash
      OR operation."expected_blocked_code"
        IS DISTINCT FROM p_expected_blocked_code
      OR operation."expected_robots_blocked"
        IS DISTINCT FROM p_expected_robots_blocked
    )
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF settlement.replay THEN
    IF artifact."expected_http_status"
        IS DISTINCT FROM p_expected_http_status
      OR artifact."expected_http_ok" IS DISTINCT FROM p_expected_http_ok
      OR artifact."expected_sanitized_url"
        IS DISTINCT FROM p_expected_sanitized_url
      OR artifact."expected_content_hash"
        IS DISTINCT FROM p_expected_content_hash
      OR artifact."expected_blocked_code"
        IS DISTINCT FROM p_expected_blocked_code
      OR artifact."expected_robots_blocked"
        IS DISTINCT FROM p_expected_robots_blocked
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    UPDATE "generic_operation_artifact" target
    SET "expected_http_status" = p_expected_http_status,
        "expected_http_ok" = p_expected_http_ok,
        "expected_sanitized_url" = p_expected_sanitized_url,
        "expected_content_hash" = p_expected_content_hash,
        "expected_blocked_code" = p_expected_blocked_code,
        "expected_robots_blocked" = p_expected_robots_blocked
    WHERE target."scope_key" = p_scope_key
      AND target."operation_id" = p_operation_id;
    UPDATE "tool_budget_operation" target
    SET "expected_http_status" = p_expected_http_status,
        "expected_http_ok" = p_expected_http_ok,
        "expected_sanitized_url" = p_expected_sanitized_url,
        "expected_content_hash" = p_expected_content_hash,
        "expected_blocked_code" = p_expected_blocked_code,
        "expected_robots_blocked" = p_expected_robots_blocked
    WHERE target."scope_key" = p_scope_key
      AND target."id" = p_operation_id;
  END IF;
  RETURN QUERY SELECT settlement.charged_cents,
    settlement.observed_cents, settlement.cap_variance,
    settlement.status, settlement.replay;
END
$$;
REVOKE ALL ON FUNCTION
  generic_operation_artifact_sanitized_url_valid_v1(TEXT),
  generic_operation_artifact_expected_facts_valid_v1(TEXT, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  assert_generic_operation_artifact_expected_facts_v1(TEXT, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  enforce_generic_operation_artifact_expected_facts_v1(),
  enforce_tool_budget_operation_expected_facts_v1(),
  append_generic_operation_artifact_internal_v2(TEXT, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  append_workspace_generic_operation_artifact_v2(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  append_platform_generic_operation_artifact_v2(UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  find_exact_workspace_generic_operation_artifact_v2(UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ),
  find_exact_platform_generic_operation_artifact_v2(UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ),
  find_workspace_generic_operation_artifact_by_operation_v2(UUID, UUID, UUID, TEXT),
  find_platform_generic_operation_artifact_by_operation_v2(UUID, UUID, TEXT),
  mark_tool_budget_result_unknown_v3(TEXT, UUID, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  load_tool_budget_result_unknown_artifact_v3(TEXT, UUID, UUID),
  settle_tool_budget_artifact_manifest_v3(TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN)
FROM PUBLIC, app_user, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION
  append_workspace_generic_operation_artifact_v2(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  find_exact_workspace_generic_operation_artifact_v2(UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ),
  find_workspace_generic_operation_artifact_by_operation_v2(UUID, UUID, UUID, TEXT),
  mark_tool_budget_result_unknown_v3(TEXT, UUID, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  load_tool_budget_result_unknown_artifact_v3(TEXT, UUID, UUID),
  settle_tool_budget_artifact_manifest_v3(TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN)
TO app_user;
GRANT EXECUTE ON FUNCTION
  append_platform_generic_operation_artifact_v2(UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  find_exact_platform_generic_operation_artifact_v2(UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ),
  find_platform_generic_operation_artifact_by_operation_v2(UUID, UUID, TEXT),
  mark_tool_budget_result_unknown_v3(TEXT, UUID, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  load_tool_budget_result_unknown_artifact_v3(TEXT, UUID, UUID),
  settle_tool_budget_artifact_manifest_v3(TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN)
TO execution_budget_platform_writer;
ALTER TABLE "generic_operation_artifact"
  ADD COLUMN "expected_http_status" SMALLINT,
  ADD COLUMN "expected_http_ok" BOOLEAN,
  ADD COLUMN "expected_sanitized_url" VARCHAR(2000),
  ADD COLUMN "expected_content_hash" CHAR(24),
  ADD COLUMN "expected_blocked_code" VARCHAR(80),
  ADD COLUMN "expected_robots_blocked" BOOLEAN;
ALTER TABLE "tool_budget_operation"
  ADD COLUMN "expected_http_status" SMALLINT,
  ADD COLUMN "expected_http_ok" BOOLEAN,
  ADD COLUMN "expected_sanitized_url" VARCHAR(2000),
  ADD COLUMN "expected_content_hash" CHAR(24),
  ADD COLUMN "expected_blocked_code" VARCHAR(80),
  ADD COLUMN "expected_robots_blocked" BOOLEAN;
ALTER TABLE "generic_operation_artifact"
  ADD CONSTRAINT "generic_operation_artifact_expected_facts_check" CHECK (
    (
      "expected_http_status" IS NULL
      AND "expected_http_ok" IS NULL
      AND "expected_sanitized_url" IS NULL
      AND "expected_content_hash" IS NULL
      AND "expected_blocked_code" IS NULL
      AND "expected_robots_blocked" IS NULL
    ) OR (
      generic_operation_artifact_expected_facts_valid_v1(
        "result_schema", "expected_http_status", "expected_http_ok",
        "expected_sanitized_url", "expected_content_hash",
        "expected_blocked_code", "expected_robots_blocked"
      )
    )
  ) NOT VALID;
ALTER TABLE "tool_budget_operation"
  ADD CONSTRAINT "tool_budget_operation_expected_facts_check" CHECK (
    (
      "expected_http_status" IS NULL
      AND "expected_http_ok" IS NULL
      AND "expected_sanitized_url" IS NULL
      AND "expected_content_hash" IS NULL
      AND "expected_blocked_code" IS NULL
      AND "expected_robots_blocked" IS NULL
    ) OR (
      "status" IN ('RESULT_UNKNOWN', 'SETTLED')
      AND generic_operation_artifact_expected_facts_valid_v1(
        COALESCE(
          "result_schema", "expected_artifact"->'manifest'->>'resultSchema'
        ),
        "expected_http_status", "expected_http_ok",
        "expected_sanitized_url", "expected_content_hash",
        "expected_blocked_code", "expected_robots_blocked"
      )
    )
  ) NOT VALID;
CREATE CONSTRAINT TRIGGER "generic_operation_artifact_expected_facts_guard"
AFTER INSERT OR UPDATE OF
  "result_schema", "expected_http_status", "expected_http_ok",
  "expected_sanitized_url", "expected_content_hash",
  "expected_blocked_code", "expected_robots_blocked"
ON "generic_operation_artifact"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_generic_operation_artifact_expected_facts_v1();
CREATE CONSTRAINT TRIGGER "tool_budget_operation_expected_facts_guard"
AFTER UPDATE OF
  "status", "result_schema", "expected_artifact", "expected_http_status",
  "expected_http_ok", "expected_sanitized_url", "expected_content_hash",
  "expected_blocked_code", "expected_robots_blocked"
ON "tool_budget_operation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_tool_budget_operation_expected_facts_v1();
COMMIT;
