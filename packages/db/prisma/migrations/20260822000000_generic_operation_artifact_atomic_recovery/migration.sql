-- Bind recoverable unknown artifact facts to the original operation and settle
-- manifest plus closed reference in one PostgreSQL transaction primitive.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

ALTER TABLE "tool_budget_account"
  DROP CONSTRAINT "tool_budget_account_authority_shape_check",
  ADD CONSTRAINT "tool_budget_account_authority_shape_check" CHECK (
    ("authority_id" IS NULL AND "authorized_cap_microusd" IS NULL)
    OR (
      "authority_id" IS NOT NULL
      AND "authorized_cap_microusd" IS NOT NULL
      AND "authorized_cap_microusd" > 0
      AND "cap_cents" <= "authorized_cap_microusd" / 10000
    )
  );

ALTER TABLE "tool_budget_operation"
  ADD COLUMN "expected_artifact" JSONB,
  ADD CONSTRAINT "tool_budget_operation_expected_artifact_check" CHECK (
    "expected_artifact" IS NULL
    OR (
      "status" IN ('RESULT_UNKNOWN', 'SETTLED')
      AND jsonb_typeof("expected_artifact") = 'object'
      AND octet_length("expected_artifact"::text) <= 16384
      AND "expected_artifact" ?& ARRAY[
        'schemaVersion', 'scopeKey', 'accountId', 'accountKey',
        'generation', 'authorityId', 'operationId', 'manifest'
      ]
      AND (
        "expected_artifact" - ARRAY[
          'schemaVersion', 'scopeKey', 'accountId', 'accountKey',
          'generation', 'authorityId', 'operationId', 'manifest'
        ]
      ) = '{}'::jsonb
      AND "expected_artifact"->>'schemaVersion'
        = 'generic-operation-artifact-unknown/v1'
      AND "expected_artifact"->>'scopeKey' = "scope_key"
      AND "expected_artifact"->>'accountId' = "account_id"::text
      AND "expected_artifact"->>'generation' = "generation"::text
      AND "expected_artifact"->>'operationId' = "id"::text
      AND jsonb_typeof("expected_artifact"->'manifest') = 'object'
    )
  );

-- Do not infer expected facts from predecessor manifests. The old recovery
-- contract accepted caller-supplied manifests, so a pre-existing RESERVED or
-- RESULT_UNKNOWN row cannot be promoted into trusted recovery provenance by a
-- migration. Such rows remain fail-closed and require separately reviewed
-- reconciliation; only v2 transitions may create expected_artifact.

CREATE FUNCTION assert_generic_operation_artifact_manifest_v2(
  p_scope_key TEXT,
  p_operation_id UUID,
  p_authority_id UUID,
  p_manifest JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parsed_artifact_id UUID;
  parsed_size BIGINT;
  parsed_created TIMESTAMPTZ;
  parsed_expiry TIMESTAMPTZ;
BEGIN
  IF p_scope_key IS NULL
    OR p_operation_id IS NULL
    OR p_authority_id IS NULL
    OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_manifest)) <> 15
    OR NOT p_manifest ?& ARRAY[
      'schemaVersion', 'artifactId', 'scopeKind', 'workspaceId',
      'authorityId', 'operationId', 'resultSchema', 'objectKey', 'sha256',
      'sizeBytes', 'mediaType', 'privacyClass', 'sourceDigest', 'createdAt',
      'expiresAt'
    ]
    OR (
      p_manifest - ARRAY[
        'schemaVersion', 'artifactId', 'scopeKind', 'workspaceId',
        'authorityId', 'operationId', 'resultSchema', 'objectKey', 'sha256',
        'sizeBytes', 'mediaType', 'privacyClass', 'sourceDigest', 'createdAt',
        'expiresAt'
      ]
    ) <> '{}'::jsonb
    OR p_manifest->>'schemaVersion'
      IS DISTINCT FROM 'generic-operation-artifact/v1'
    OR NOT COALESCE(
      (p_manifest->>'artifactId') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      false
    )
    OR p_manifest->>'authorityId' IS DISTINCT FROM p_authority_id::text
    OR p_manifest->>'operationId' IS DISTINCT FROM p_operation_id::text
    OR NOT COALESCE(
      char_length(p_manifest->>'resultSchema') BETWEEN 1 AND 100
      AND (p_manifest->>'resultSchema') ~ '^[a-z0-9][a-z0-9._/-]*$',
      false
    )
    OR NOT COALESCE((p_manifest->>'sha256') ~ '^[0-9a-f]{64}$', false)
    OR p_manifest->>'objectKey' IS DISTINCT FROM (
      'generic-operation-results/v1/sha256/'
      || left(p_manifest->>'sha256', 2) || '/'
      || (p_manifest->>'sha256')
    )
    OR NOT COALESCE(
      (p_manifest->>'sizeBytes') ~ '^(0|[1-9][0-9]{0,18})$',
      false
    )
    OR NOT COALESCE(
      char_length(p_manifest->>'mediaType') <= 160
      AND (p_manifest->>'mediaType') ~
        '^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$',
      false
    )
    OR p_manifest->>'privacyClass' NOT IN (
      'PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT', 'PERSONAL_DATA'
    )
    OR NOT (
      p_manifest->'sourceDigest' = 'null'::jsonb
      OR COALESCE((p_manifest->>'sourceDigest') ~ '^[0-9a-f]{64}$', false)
    )
    OR NOT COALESCE(
      (p_manifest->>'createdAt') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$',
      false
    )
    OR NOT COALESCE(
      (p_manifest->>'expiresAt') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$',
      false
    )
    OR (
      p_scope_key = 'platform'
      AND (
        p_manifest->>'scopeKind' IS DISTINCT FROM 'platform'
        OR p_manifest->'workspaceId' IS DISTINCT FROM 'null'::jsonb
      )
    )
    OR (
      p_scope_key <> 'platform'
      AND (
        p_manifest->>'scopeKind' IS DISTINCT FROM 'workspace'
        OR p_manifest->>'workspaceId' IS DISTINCT FROM p_scope_key
      )
    )
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    parsed_artifact_id := (p_manifest->>'artifactId')::UUID;
    parsed_size := (p_manifest->>'sizeBytes')::BIGINT;
    parsed_created := (p_manifest->>'createdAt')::TIMESTAMPTZ;
    parsed_expiry := (p_manifest->>'expiresAt')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END;

  IF parsed_artifact_id::text IS DISTINCT FROM p_manifest->>'artifactId'
    OR parsed_size::text IS DISTINCT FROM p_manifest->>'sizeBytes'
    OR to_char(
      parsed_created AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) IS DISTINCT FROM p_manifest->>'createdAt'
    OR to_char(
      parsed_expiry AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) IS DISTINCT FROM p_manifest->>'expiresAt'
    OR parsed_expiry <= parsed_created
    OR parsed_expiry <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

CREATE FUNCTION guard_tool_budget_expected_artifact_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."expected_artifact" IS DISTINCT FROM OLD."expected_artifact"
    AND NOT (
      OLD."status" = 'RESERVED'
      AND OLD."expected_artifact" IS NULL
      AND NEW."status" = 'RESULT_UNKNOWN'
      AND NEW."expected_artifact" IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "tool_budget_operation_expected_artifact_guard"
BEFORE UPDATE OF "expected_artifact" ON "tool_budget_operation"
FOR EACH ROW
EXECUTE FUNCTION guard_tool_budget_expected_artifact_v2();

CREATE FUNCTION mark_tool_budget_result_unknown_v2(
  p_scope_key TEXT,
  p_operation_id UUID,
  p_expected_manifest JSONB DEFAULT NULL
)
RETURNS TABLE(
  reserved_cents BIGINT,
  status TEXT,
  replay BOOLEAN,
  recoverable BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  expected_envelope JSONB;
BEGIN
  IF p_scope_key IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR UPDATE;
  SELECT target.* INTO account
  FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = operation."account_id"
  FOR UPDATE;

  IF operation."id" IS NULL
    OR account."id" IS NULL
    OR account."authority_id" IS NULL
    OR operation."generation" IS DISTINCT FROM account."generation"
    OR operation."result_schema_version" IS NOT NULL
    OR operation."result_schema" IS NOT NULL
    OR operation."result_digest" IS NOT NULL
    OR operation."result_json" IS NOT NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_expected_manifest IS NOT NULL THEN
    PERFORM assert_generic_operation_artifact_manifest_v2(
      p_scope_key, operation."id", account."authority_id",
      p_expected_manifest
    );
    expected_envelope := jsonb_build_object(
      'schemaVersion', 'generic-operation-artifact-unknown/v1',
      'scopeKey', operation."scope_key",
      'accountId', operation."account_id"::text,
      'accountKey', account."account_key",
      'generation', operation."generation"::text,
      'authorityId', account."authority_id"::text,
      'operationId', operation."id"::text,
      'manifest', p_expected_manifest
    );
  END IF;

  IF operation."status" = 'RESERVED' THEN
    UPDATE "tool_budget_operation" target
    SET "status" = 'RESULT_UNKNOWN',
        "expected_artifact" = expected_envelope
    WHERE target."scope_key" = p_scope_key
      AND target."id" = p_operation_id
    RETURNING target.* INTO operation;
    RETURN QUERY SELECT
      operation."reserved_cents", operation."status"::text, false,
      operation."expected_artifact" IS NOT NULL;
    RETURN;
  END IF;
  IF operation."status" = 'RESULT_UNKNOWN'
    AND operation."expected_artifact" IS NOT DISTINCT FROM expected_envelope
  THEN
    RETURN QUERY SELECT
      operation."reserved_cents", operation."status"::text, true,
      operation."expected_artifact" IS NOT NULL;
    RETURN;
  END IF;
  RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
    USING ERRCODE = 'P0001';
END
$$;

CREATE FUNCTION load_tool_budget_result_unknown_artifact_v2(
  p_scope_key TEXT,
  p_operation_id UUID,
  p_authority_id UUID
)
RETURNS TABLE(expected_manifest JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  manifest JSONB;
BEGIN
  IF p_scope_key IS NULL OR p_operation_id IS NULL OR p_authority_id IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR SHARE;
  SELECT target.* INTO account
  FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = operation."account_id"
  FOR SHARE;
  manifest := operation."expected_artifact"->'manifest';

  IF operation."id" IS NULL
    OR operation."status" <> 'RESULT_UNKNOWN'
    OR operation."expected_artifact" IS NULL
    OR account."id" IS NULL
    OR account."authority_id" IS DISTINCT FROM p_authority_id
    OR operation."expected_artifact"->>'scopeKey'
      IS DISTINCT FROM operation."scope_key"
    OR operation."expected_artifact"->>'accountId'
      IS DISTINCT FROM operation."account_id"::text
    OR operation."expected_artifact"->>'accountKey'
      IS DISTINCT FROM account."account_key"
    OR operation."expected_artifact"->>'generation'
      IS DISTINCT FROM operation."generation"::text
    OR operation."expected_artifact"->>'authorityId'
      IS DISTINCT FROM account."authority_id"::text
    OR operation."expected_artifact"->>'operationId'
      IS DISTINCT FROM operation."id"::text
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM assert_generic_operation_artifact_manifest_v2(
    p_scope_key, operation."id", account."authority_id", manifest
  );
  RETURN QUERY SELECT manifest;
END
$$;

CREATE FUNCTION settle_tool_budget_artifact_manifest_v2(
  p_scope_key TEXT,
  p_operation_id UUID,
  p_observed_cents BIGINT,
  p_manifest JSONB
)
RETURNS TABLE(
  charged_cents BIGINT,
  observed_cents BIGINT,
  cap_variance BOOLEAN,
  status TEXT,
  replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  appended RECORD;
  reference JSONB;
BEGIN
  IF p_scope_key IS NULL
    OR p_operation_id IS NULL
    OR p_observed_cents IS NULL
    OR p_observed_cents < 0
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR NOT COALESCE((p_manifest->>'sha256') ~ '^[0-9a-f]{64}$', false)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  -- Match append_generic_operation_artifact_internal_v1 exactly: operation
  -- advisory lock, content advisory lock, then manifest/operation rows. Taking
  -- row locks first would deadlock with a rolling predecessor append.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'generic-operation-artifact-operation:'
      || p_scope_key || ':' || p_operation_id::text,
      0
    )
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'generic-operation-artifact-object:' || (p_manifest->>'sha256'),
      0
    )
  );

  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR UPDATE;
  SELECT target.* INTO account
  FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = operation."account_id"
  FOR UPDATE;
  IF operation."id" IS NULL
    OR account."id" IS NULL
    OR account."authority_id" IS NULL
    OR operation."generation" IS DISTINCT FROM account."generation"
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM assert_generic_operation_artifact_manifest_v2(
    p_scope_key, operation."id", account."authority_id", p_manifest
  );
  reference := jsonb_build_object(
    'schemaVersion', 'generic-operation-artifact-ref/v1',
    'artifactId', p_manifest->>'artifactId',
    'operationId', p_manifest->>'operationId',
    'resultSchema', p_manifest->>'resultSchema',
    'sha256', p_manifest->>'sha256',
    'sizeBytes', p_manifest->>'sizeBytes',
    'mediaType', p_manifest->>'mediaType',
    'expiresAt', p_manifest->>'expiresAt'
  );

  IF operation."status" = 'SETTLED' THEN
    IF operation."observed_cents" IS DISTINCT FROM p_observed_cents
      OR operation."result_schema_version"
        IS DISTINCT FROM 'generic-operation-artifact-ref/v1'
      OR operation."result_schema" IS DISTINCT FROM p_manifest->>'resultSchema'
      OR operation."result_digest" IS DISTINCT FROM p_manifest->>'sha256'
      OR operation."result_json" IS DISTINCT FROM reference
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM 1
    FROM "generic_operation_artifact" artifact
    WHERE artifact."scope_key" = p_scope_key
      AND artifact."operation_id" = p_operation_id
      AND artifact."authority_id" = account."authority_id"
      AND artifact."id" = (p_manifest->>'artifactId')::UUID
      AND artifact."result_schema" = p_manifest->>'resultSchema'
      AND artifact."sha256" = p_manifest->>'sha256'
      AND artifact."size_bytes" = (p_manifest->>'sizeBytes')::BIGINT
      AND artifact."media_type" = p_manifest->>'mediaType'
      AND artifact."privacy_class" = p_manifest->>'privacyClass'
      AND artifact."source_digest" IS NOT DISTINCT FROM p_manifest->>'sourceDigest'
      AND artifact."created_at" = (p_manifest->>'createdAt')::TIMESTAMPTZ
      AND artifact."expires_at" = (p_manifest->>'expiresAt')::TIMESTAMPTZ;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT
      operation."charged_cents", operation."observed_cents",
      operation."observed_cents" > operation."reserved_cents",
      operation."status"::text, true;
    RETURN;
  END IF;

  IF operation."status" NOT IN ('RESERVED', 'RESULT_UNKNOWN')
    OR (
      operation."status" = 'RESULT_UNKNOWN'
      AND (
        operation."expected_artifact" IS NULL
        OR operation."expected_artifact"->'manifest' IS DISTINCT FROM p_manifest
      )
    )
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO appended
  FROM append_generic_operation_artifact_internal_v1(
    p_scope_key,
    (p_manifest->>'workspaceId')::UUID,
    (p_manifest->>'artifactId')::UUID,
    account."authority_id",
    operation."id",
    p_manifest->>'resultSchema',
    p_manifest->>'objectKey',
    p_manifest->>'sha256',
    (p_manifest->>'sizeBytes')::BIGINT,
    p_manifest->>'mediaType',
    p_manifest->>'privacyClass',
    p_manifest->>'sourceDigest',
    (p_manifest->>'createdAt')::TIMESTAMPTZ,
    (p_manifest->>'expiresAt')::TIMESTAMPTZ
  );
  IF appended.artifact_id IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE "tool_budget_operation" target
  SET "observed_cents" = p_observed_cents,
      "charged_cents" = operation."reserved_cents",
      "status" = 'SETTLED',
      "result_schema_version" = 'generic-operation-artifact-ref/v1',
      "result_schema" = p_manifest->>'resultSchema',
      "result_digest" = p_manifest->>'sha256',
      "result_json" = reference,
      "settled_at" = clock_timestamp()
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  RETURNING target.* INTO operation;

  UPDATE "tool_budget_account" target
  SET "reserved_cents" = target."reserved_cents" - operation."reserved_cents",
      "charged_cents" = target."charged_cents" + operation."reserved_cents",
      "exhausted" = (
        target."exhausted"
        OR p_observed_cents > operation."reserved_cents"
      ),
      "updated_at" = clock_timestamp()
  WHERE target."scope_key" = p_scope_key
    AND target."id" = operation."account_id";

  RETURN QUERY SELECT
    operation."charged_cents", operation."observed_cents",
    operation."observed_cents" > operation."reserved_cents",
    operation."status"::text, false;
END
$$;

REVOKE ALL ON FUNCTION
  assert_generic_operation_artifact_manifest_v2(TEXT, UUID, UUID, JSONB),
  guard_tool_budget_expected_artifact_v2(),
  mark_tool_budget_result_unknown_v1(TEXT, UUID),
  settle_tool_budget_artifact_reference_v1(TEXT, UUID, BIGINT, JSONB),
  mark_tool_budget_result_unknown_v2(TEXT, UUID, JSONB),
  load_tool_budget_result_unknown_artifact_v2(TEXT, UUID, UUID),
  settle_tool_budget_artifact_manifest_v2(TEXT, UUID, BIGINT, JSONB)
FROM PUBLIC, app_user, execution_budget_platform_writer;

GRANT EXECUTE ON FUNCTION
  mark_tool_budget_result_unknown_v2(TEXT, UUID, JSONB),
  load_tool_budget_result_unknown_artifact_v2(TEXT, UUID, UUID),
  settle_tool_budget_artifact_manifest_v2(TEXT, UUID, BIGINT, JSONB)
TO app_user;

GRANT EXECUTE ON FUNCTION
  mark_tool_budget_result_unknown_v2(TEXT, UUID, JSONB),
  load_tool_budget_result_unknown_artifact_v2(TEXT, UUID, UUID),
  settle_tool_budget_artifact_manifest_v2(TEXT, UUID, BIGINT, JSONB)
TO execution_budget_platform_writer;

COMMIT;
