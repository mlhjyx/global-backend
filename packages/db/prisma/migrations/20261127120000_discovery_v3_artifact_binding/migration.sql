BEGIN;

SET LOCAL lock_timeout = '5s';

-- Keep the v2 authority/account chain and add a separately tenant-bound v3
-- operation key. Both versions use the same object, subject and erasure index.
ALTER TABLE "generic_operation_artifact"
  ALTER COLUMN "authority_id" DROP NOT NULL,
  ALTER COLUMN "operation_id" DROP NOT NULL,
  ADD COLUMN "execution_contract_version" SMALLINT NOT NULL DEFAULT 2,
  ADD COLUMN "discovery_v3_operation_id" UUID,
  ADD CONSTRAINT "generic_operation_artifact_execution_binding_check" CHECK (
    ("execution_contract_version" = 2 AND "authority_id" IS NOT NULL
      AND "operation_id" IS NOT NULL AND "discovery_v3_operation_id" IS NULL)
    OR
    ("execution_contract_version" = 3 AND "authority_id" IS NULL
      AND "operation_id" IS NULL AND "discovery_v3_operation_id" IS NOT NULL
      AND "workspace_id" IS NOT NULL AND "privacy_class" = 'PERSONAL_DATA')
  ) NOT VALID,
  ADD CONSTRAINT "generic_operation_artifact_discovery_v3_operation_fkey"
    FOREIGN KEY ("workspace_id", "discovery_v3_operation_id")
    REFERENCES "discovery_v3_operation" ("workspace_id", "id") NOT VALID,
  ADD CONSTRAINT "generic_operation_artifact_discovery_v3_operation_key"
    UNIQUE ("workspace_id", "discovery_v3_operation_id");

CREATE FUNCTION discovery_v3_artifact_reference_v1(artifact "generic_operation_artifact")
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 'generic-operation-artifact-ref/v1',
    'artifactId', artifact."id",
    'operationId', artifact."discovery_v3_operation_id",
    'resultSchema', artifact."result_schema",
    'sha256', artifact."sha256"::text,
    'sizeBytes', artifact."size_bytes"::text,
    'mediaType', artifact."media_type",
    'expiresAt', to_char(artifact."expires_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$$;

CREATE FUNCTION discovery_v3_artifact_result_schema_v1(p_producer TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_producer
    WHEN 'crawl4ai.fetch' THEN 'crawl4ai-fetch/v1'
    WHEN 'crawl4ai.render' THEN 'crawl4ai-render/v1'
    WHEN 'http.get' THEN 'http-get/v1'
    WHEN 'contact_email.find.hunter' THEN 'contact-email-find-hunter/v1'
    WHEN 'contact_email.find.prospeo' THEN 'contact-email-find-prospeo/v1'
  END;
$$;

-- This preflight holds the same subject/object locks as the DSR path, from
-- before final object promotion through commit. A completed erasure is a
-- permanent fence for the subject and for its retired final object key.
CREATE FUNCTION prepare_discovery_v3_artifact_v1(
  p_workspace UUID, p_operation UUID, p_request_digest TEXT,
  p_subject_type TEXT, p_subject UUID, p_projection JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  operation "discovery_v3_operation"%ROWTYPE;
  artifact "generic_operation_artifact"%ROWTYPE;
  reference JSONB;
  schema_name TEXT;
  expected_media TEXT;
  maximum_size BIGINT;
  bound_object_key TEXT;
  hold RECORD;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace IS NULL OR p_workspace IS DISTINCT FROM current_workspace_id()
    OR p_operation IS NULL OR p_request_digest IS NULL OR p_request_digest !~ '^[0-9a-f]{64}$'
    OR p_subject_type IS NULL OR p_subject_type NOT IN ('contact', 'company', 'company_profile')
    OR p_subject IS NULL
    OR jsonb_typeof(p_projection) IS DISTINCT FROM 'object'
    OR p_projection - ARRAY['schemaVersion', 'kind', 'schema', 'data', 'digest'] <> '{}'::jsonb
    OR p_projection->>'schemaVersion' IS DISTINCT FROM 'generic-operation-projection/v1'
    OR p_projection->>'kind' IS DISTINCT FROM 'tool'
    OR p_projection->>'schema' IS DISTINCT FROM 'discovery-v3-artifact-reference/v1'
    OR NOT COALESCE(p_projection->>'digest' ~ '^[0-9a-f]{64}$', false)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO operation
  FROM "discovery_v3_operation" target
  WHERE target."workspace_id" = p_workspace AND target."id" = p_operation
    AND target."request_sha256" = p_request_digest AND target."kind" = 'TOOL'
    AND target."status" = 'SUCCEEDED' AND target."send_authorized_at" IS NOT NULL
    AND target."method" = 'invoke' AND target."provider" = target."action"
    AND target."result_sha256" = p_projection->>'digest' AND target."result" = p_projection
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  reference := p_projection->'data';
  schema_name := discovery_v3_artifact_result_schema_v1(operation."action");
  SELECT configured.media, configured.max_size INTO expected_media, maximum_size
  FROM (VALUES
    ('crawl4ai-fetch/v1', 'text/markdown', 300000),
    ('crawl4ai-render/v1', 'text/html', 3000000),
    ('http-get/v1', 'text/plain', 3000000),
    ('contact-email-find-hunter/v1', 'application/octet-stream', 16384),
    ('contact-email-find-prospeo/v1', 'application/octet-stream', 16384)
  ) AS configured(schema, media, max_size) WHERE configured.schema = schema_name;
  IF maximum_size IS NULL
    OR (expected_media = 'application/octet-stream' AND p_subject_type <> 'contact')
    OR jsonb_typeof(reference) IS DISTINCT FROM 'object'
    OR reference - ARRAY['schemaVersion', 'artifactId', 'operationId', 'resultSchema',
      'sha256', 'sizeBytes', 'mediaType', 'expiresAt'] <> '{}'::jsonb
    OR reference->>'schemaVersion' IS DISTINCT FROM 'generic-operation-artifact-ref/v1'
    OR NOT COALESCE(reference->>'artifactId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
    OR reference->>'operationId' IS DISTINCT FROM p_operation::text
    OR reference->>'resultSchema' IS DISTINCT FROM schema_name
    OR reference->>'mediaType' IS DISTINCT FROM expected_media
    OR NOT COALESCE(reference->>'sha256' ~ '^[0-9a-f]{64}$', false)
    OR NOT COALESCE(reference->>'sizeBytes' ~ '^(0|[1-9][0-9]{0,6})$', false)
    OR NOT COALESCE(reference->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$', false)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF (reference->>'sizeBytes')::bigint > maximum_size
    OR (reference->>'expiresAt')::timestamptz <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-subject:' || p_workspace::text || ':' || p_subject_type || ':' || p_subject::text, 0
  ));
  PERFORM assert_workspace_generic_operation_artifact_subject_v1(p_workspace, p_subject_type, p_subject);
  SELECT * INTO hold
  FROM find_workspace_generic_operation_artifact_subject_execution_hold_v1(p_workspace, p_subject_type, p_subject);
  IF NOT FOUND OR hold.tombstoned OR hold.suppressed THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  bound_object_key := 'generic-operation-results/v1/final/personal-data/ws/' || p_workspace::text
    || '/sha256/' || left(reference->>'sha256', 2) || '/' || (reference->>'sha256');
  PERFORM pg_advisory_xact_lock(hashtextextended('generic-operation-artifact-object:' || bound_object_key, 0));
  IF EXISTS (
    SELECT 1 FROM "personal_artifact_cleanup_command" cleanup WHERE cleanup."object_key" = bound_object_key
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED' USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO artifact
  FROM "generic_operation_artifact" target
  WHERE target."workspace_id" = p_workspace AND target."discovery_v3_operation_id" = p_operation;
  IF NOT FOUND THEN RETURN false; END IF;
  IF artifact."execution_contract_version" <> 3
    OR artifact."object_key" IS DISTINCT FROM bound_object_key
    OR discovery_v3_artifact_reference_v1(artifact) IS DISTINCT FROM reference
    OR NOT EXISTS (
      SELECT 1
      FROM "generic_operation_artifact_subject" subject
      WHERE subject."artifact_id" = artifact."id" AND subject."scope_key" = artifact."scope_key"
        AND subject."workspace_id" = p_workspace AND subject."subject_type" = p_subject_type
        AND subject."subject_id" = p_subject
    )
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION append_discovery_v3_artifact_v1(
  p_workspace UUID, p_operation UUID, p_request_digest TEXT, p_subject_type TEXT,
  p_subject UUID, p_projection JSONB, p_created_at TIMESTAMPTZ, p_object_version TEXT,
  p_http_status SMALLINT, p_http_ok BOOLEAN, p_url TEXT, p_content_hash TEXT,
  p_blocked_code TEXT, p_robots_blocked BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  reference JSONB := p_projection->'data';
  bound_object_key TEXT;
  body_sha256 TEXT;
  body_size BIGINT;
  expiry TIMESTAMPTZ;
  artifact "generic_operation_artifact"%ROWTYPE;
BEGIN
  IF prepare_discovery_v3_artifact_v1(p_workspace, p_operation, p_request_digest, p_subject_type, p_subject, p_projection) THEN
    RETURN;
  END IF;
  body_sha256 := reference->>'sha256';
  body_size := (reference->>'sizeBytes')::bigint;
  expiry := (reference->>'expiresAt')::timestamptz;
  IF p_created_at IS NULL OR expiry <= p_created_at OR expiry > p_created_at + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  bound_object_key := 'generic-operation-results/v1/final/personal-data/ws/' || p_workspace::text
    || '/sha256/' || left(body_sha256, 2) || '/' || body_sha256;

  INSERT INTO "generic_operation_artifact_object" ("sha256", "object_key", "size_bytes", "media_type", "privacy_class")
    VALUES (body_sha256, bound_object_key, body_size, reference->>'mediaType', 'PERSONAL_DATA')
    ON CONFLICT ("object_key") DO NOTHING;
  PERFORM record_generic_operation_artifact_object_version_v2(bound_object_key, body_sha256, 'PERSONAL_DATA', p_object_version);

  INSERT INTO "generic_operation_artifact" (
    "id", "scope_key", "workspace_id", "execution_contract_version", "discovery_v3_operation_id",
    "result_schema", "object_key", "sha256", "size_bytes", "media_type", "privacy_class",
    "created_at", "expires_at", "expected_http_status", "expected_http_ok", "expected_sanitized_url",
    "expected_content_hash", "expected_blocked_code", "expected_robots_blocked"
  ) VALUES (
    (reference->>'artifactId')::uuid, p_workspace::text, p_workspace, 3, p_operation,
    reference->>'resultSchema', bound_object_key, body_sha256, body_size, reference->>'mediaType', 'PERSONAL_DATA',
    p_created_at, expiry, p_http_status, p_http_ok, p_url, p_content_hash, p_blocked_code, p_robots_blocked
  ) RETURNING * INTO artifact;

  IF discovery_v3_artifact_reference_v1(artifact) IS DISTINCT FROM reference THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  PERFORM bind_workspace_generic_operation_artifact_subject_v1(p_workspace, artifact."id", p_subject_type, p_subject);
END;
$$;

CREATE FUNCTION find_exact_discovery_v3_artifact_v1(
  p_workspace UUID, p_operation UUID, p_request_digest TEXT, p_subject_type TEXT,
  p_subject UUID, p_projection JSONB
)
RETURNS SETOF "generic_operation_artifact"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF prepare_discovery_v3_artifact_v1(p_workspace, p_operation, p_request_digest, p_subject_type, p_subject, p_projection) THEN
    RETURN QUERY SELECT target.* FROM "generic_operation_artifact" target
    WHERE target."workspace_id" = p_workspace AND target."discovery_v3_operation_id" = p_operation;
  END IF;
END;
$$;

CREATE FUNCTION enforce_discovery_v3_artifact_receipt_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE schema_name TEXT;
BEGIN
  schema_name := discovery_v3_artifact_result_schema_v1(NEW."action");
  IF NEW."status" = 'SUCCEEDED' AND NEW."kind" = 'TOOL'
    AND (schema_name IS NOT NULL OR NEW."result"->>'schema' = 'discovery-v3-artifact-reference/v1')
    AND NOT EXISTS (
      SELECT 1 FROM "generic_operation_artifact" artifact
      WHERE artifact."workspace_id" = NEW."workspace_id"
        AND artifact."execution_contract_version" = 3 AND artifact."discovery_v3_operation_id" = NEW."id"
        AND artifact."result_schema" = schema_name
        AND NEW."result" = jsonb_build_object(
          'schemaVersion', 'generic-operation-projection/v1', 'kind', 'tool',
          'schema', 'discovery-v3-artifact-reference/v1', 'digest', NEW."result_sha256",
          'data', discovery_v3_artifact_reference_v1(artifact)
        )
    )
  THEN
    RAISE EXCEPTION 'DISCOVERY_V3_ARTIFACT_RECEIPT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "discovery_v3_artifact_receipt_guard"
AFTER INSERT OR UPDATE OF "status", "result" ON "discovery_v3_operation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_discovery_v3_artifact_receipt_v1();

REVOKE ALL ON FUNCTION
  discovery_v3_artifact_reference_v1("generic_operation_artifact"),
  discovery_v3_artifact_result_schema_v1(TEXT),
  enforce_discovery_v3_artifact_receipt_v1(),
  prepare_discovery_v3_artifact_v1(UUID, UUID, TEXT, TEXT, UUID, JSONB),
  append_discovery_v3_artifact_v1(UUID, UUID, TEXT, TEXT, UUID, JSONB, TIMESTAMPTZ, TEXT, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  find_exact_discovery_v3_artifact_v1(UUID, UUID, TEXT, TEXT, UUID, JSONB)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  prepare_discovery_v3_artifact_v1(UUID, UUID, TEXT, TEXT, UUID, JSONB),
  append_discovery_v3_artifact_v1(UUID, UUID, TEXT, TEXT, UUID, JSONB, TIMESTAMPTZ, TEXT, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN),
  find_exact_discovery_v3_artifact_v1(UUID, UUID, TEXT, TEXT, UUID, JSONB)
TO app_user;

COMMIT;

ALTER TABLE "generic_operation_artifact" VALIDATE CONSTRAINT "generic_operation_artifact_execution_binding_check";
ALTER TABLE "generic_operation_artifact" VALIDATE CONSTRAINT "generic_operation_artifact_discovery_v3_operation_fkey";
