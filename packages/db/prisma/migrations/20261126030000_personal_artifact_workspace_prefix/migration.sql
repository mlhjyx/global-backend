-- Abolish cross-tenant S3 deduplication for PERSONAL_DATA artifacts by
-- scoping PERSONAL_DATA object keys under ws/<workspace_id>/sha256/<2>/<64>.
-- PUBLIC_ORGANIZATION and CONFIDENTIAL_TENANT remain shared by digest.
-- Legacy personal-data/sha256/<2>/<64> rows already in the database remain
-- valid under table CHECKs for historical reads/cleanup, while all new writes
-- require ws/<workspace_id>/...

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

LOCK TABLE
  "generic_operation_artifact",
  "generic_operation_artifact_object",
  "generic_operation_artifact_object_version",
  "personal_artifact_cleanup_command"
  IN ACCESS EXCLUSIVE MODE;

-- 1) Pivot generic_operation_artifact_object_version to reference object_key.
ALTER TABLE "generic_operation_artifact_object_version"
  ADD COLUMN "object_key" VARCHAR(200);

UPDATE "generic_operation_artifact_object_version" v
SET "object_key" = o."object_key"
FROM "generic_operation_artifact_object" o
WHERE o."sha256" = v."sha256"
  AND o."privacy_class" = v."privacy_class";

ALTER TABLE "generic_operation_artifact_object_version"
  ALTER COLUMN "object_key" SET NOT NULL;

ALTER TABLE "generic_operation_artifact_object_version"
  DROP CONSTRAINT "generic_operation_artifact_object_version_object_fkey",
  DROP CONSTRAINT "generic_operation_artifact_object_version_pkey";

-- 2) Pivot generic_operation_artifact_object PK to ("object_key"), retaining
--    generic_operation_artifact_object_content_key for the FK from
--    generic_operation_artifact.
ALTER TABLE "generic_operation_artifact_object"
  DROP CONSTRAINT "generic_operation_artifact_object_pkey",
  DROP CONSTRAINT IF EXISTS "generic_operation_artifact_object_key_key",
  ADD CONSTRAINT "generic_operation_artifact_object_pkey"
    PRIMARY KEY ("object_key");

ALTER TABLE "generic_operation_artifact_object_version"
  ADD CONSTRAINT "generic_operation_artifact_object_version_pkey"
    PRIMARY KEY ("object_key", "object_version_id"),
  ADD CONSTRAINT "generic_operation_artifact_object_version_object_fkey"
    FOREIGN KEY ("object_key")
    REFERENCES "generic_operation_artifact_object" ("object_key")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 3) Add object_key to personal_artifact_cleanup_command, backfilled from
--    generic_operation_artifact, and pivot unique key & lookup index.
ALTER TABLE "personal_artifact_cleanup_command"
  ADD COLUMN "object_key" VARCHAR(200);

UPDATE "personal_artifact_cleanup_command" c
SET "object_key" = a."object_key"
FROM "generic_operation_artifact" a
WHERE a."id" = c."artifact_id";

ALTER TABLE "personal_artifact_cleanup_command"
  ALTER COLUMN "object_key" SET NOT NULL;

ALTER TABLE "personal_artifact_cleanup_command"
  DROP CONSTRAINT "personal_artifact_cleanup_command_request_object_key",
  ADD CONSTRAINT "personal_artifact_cleanup_command_request_object_key"
    UNIQUE ("deletion_request_id", "object_key", "object_version_id"),
  ADD CONSTRAINT "personal_artifact_cleanup_command_object_key_check" CHECK (
    "object_key" IN (
      'generic-operation-results/v1/final/personal-data/ws/'
        || "workspace_id"::text
        || '/sha256/' || substring("sha256" from 1 for 2) || '/' || "sha256",
      'generic-operation-results/v1/final/personal-data/sha256/'
        || substring("sha256" from 1 for 2) || '/' || "sha256"
    )
  );

CREATE INDEX "personal_artifact_cleanup_command_object_key_idx"
  ON "personal_artifact_cleanup_command" ("object_key");

-- 4) Update table CHECK constraints to accept both ws/<workspace_id>/... and
--    legacy personal-data/sha256/... for PERSONAL_DATA, while keeping
--    PUBLIC_ORGANIZATION and CONFIDENTIAL_TENANT shared.
ALTER TABLE "generic_operation_artifact_object"
  DROP CONSTRAINT "generic_operation_artifact_object_digest_key_check",
  ADD CONSTRAINT "generic_operation_artifact_object_digest_key_check" CHECK (
    "sha256" ~ '^[0-9a-f]{64}$'
    AND (
      (
        "privacy_class" IN ('PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT')
        AND "object_key" =
          'generic-operation-results/v1/final/'
          || CASE "privacy_class"
            WHEN 'PUBLIC_ORGANIZATION' THEN 'public-organization'
            WHEN 'CONFIDENTIAL_TENANT' THEN 'confidential-tenant'
            ELSE NULL
          END
          || '/sha256/' || substring("sha256" from 1 for 2) || '/' || "sha256"
      )
      OR (
        "privacy_class" = 'PERSONAL_DATA'
        AND (
          "object_key" ~ (
            '^generic-operation-results/v1/final/personal-data/ws/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/sha256/'
            || substring("sha256" from 1 for 2) || '/' || "sha256" || '$'
          )
          OR "object_key" =
            'generic-operation-results/v1/final/personal-data/sha256/'
            || substring("sha256" from 1 for 2) || '/' || "sha256"
        )
      )
    )
  );

ALTER TABLE "generic_operation_artifact"
  DROP CONSTRAINT "generic_operation_artifact_digest_key_check",
  ADD CONSTRAINT "generic_operation_artifact_digest_key_check" CHECK (
    "sha256" ~ '^[0-9a-f]{64}$'
    AND ("source_digest" IS NULL OR "source_digest" ~ '^[0-9a-f]{64}$')
    AND (
      (
        "privacy_class" IN ('PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT')
        AND "object_key" =
          'generic-operation-results/v1/final/'
          || CASE "privacy_class"
            WHEN 'PUBLIC_ORGANIZATION' THEN 'public-organization'
            WHEN 'CONFIDENTIAL_TENANT' THEN 'confidential-tenant'
            ELSE NULL
          END
          || '/sha256/' || substring("sha256" from 1 for 2) || '/' || "sha256"
      )
      OR (
        "privacy_class" = 'PERSONAL_DATA'
        AND "scope_key" <> 'platform'
        AND "workspace_id" IS NOT NULL
        AND "object_key" IN (
          'generic-operation-results/v1/final/personal-data/ws/'
            || "workspace_id"::text
            || '/sha256/' || substring("sha256" from 1 for 2) || '/' || "sha256",
          'generic-operation-results/v1/final/personal-data/sha256/'
            || substring("sha256" from 1 for 2) || '/' || "sha256"
        )
      )
    )
  );

-- 5) Require ws/<workspace_id>/... on all new PERSONAL_DATA manifest assertions
--    and appends, and key all object locks / lookups / ledgers / cleanup fences
--    by object_key.
CREATE OR REPLACE FUNCTION assert_generic_operation_artifact_manifest_v2(
  p_scope_key TEXT,
  p_operation_id UUID,
  p_authority_id UUID,
  p_manifest JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
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
    OR (p_manifest->>'objectKey') IS NULL
    OR (
      p_manifest->>'privacyClass' = 'PERSONAL_DATA'
      AND p_scope_key = 'platform'
    )
    OR p_manifest->>'objectKey' IS DISTINCT FROM (
      'generic-operation-results/v1/final/'
      || CASE p_manifest->>'privacyClass'
        WHEN 'PUBLIC_ORGANIZATION' THEN 'public-organization'
        WHEN 'CONFIDENTIAL_TENANT' THEN 'confidential-tenant'
        WHEN 'PERSONAL_DATA' THEN
          CASE
            WHEN p_scope_key <> 'platform' THEN 'personal-data/ws/' || p_scope_key
            ELSE NULL
          END
        ELSE NULL
      END
      || '/sha256/' || left(p_manifest->>'sha256', 2) || '/'
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

CREATE OR REPLACE FUNCTION append_generic_operation_artifact_internal_v1(
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
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE(
  artifact_id UUID,
  scope_key VARCHAR(200),
  workspace_id UUID,
  authority_id UUID,
  operation_id UUID,
  result_schema VARCHAR(100),
  object_key VARCHAR(200),
  sha256 CHAR(64),
  size_bytes BIGINT,
  media_type VARCHAR(160),
  privacy_class VARCHAR(40),
  source_digest CHAR(64),
  created_at TIMESTAMPTZ(3),
  expires_at TIMESTAMPTZ(3),
  replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  existing "generic_operation_artifact"%ROWTYPE;
  stored "generic_operation_artifact"%ROWTYPE;
  bound_operation RECORD;
  bound_object "generic_operation_artifact_object"%ROWTYPE;
  expected_object_key TEXT;
BEGIN
  IF p_scope_key IS NULL
    OR NOT COALESCE(char_length(p_scope_key) BETWEEN 1 AND 200, false)
    OR p_artifact_id IS NULL
    OR p_authority_id IS NULL
    OR p_operation_id IS NULL
    OR NOT COALESCE(
      char_length(p_result_schema) BETWEEN 1 AND 100
      AND p_result_schema ~ '^[a-z0-9][a-z0-9._/-]*$',
      false
    )
    OR NOT COALESCE(p_sha256 ~ '^[0-9a-f]{64}$', false)
    OR p_size_bytes IS NULL
    OR NOT COALESCE(p_size_bytes >= 0, false)
    OR NOT COALESCE(
      char_length(p_media_type) <= 160
      AND p_media_type ~
        '^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$',
      false
    )
    OR NOT COALESCE(p_privacy_class IN (
      'PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT', 'PERSONAL_DATA'
    ), false)
    OR NOT COALESCE(
      p_source_digest IS NULL OR p_source_digest ~ '^[0-9a-f]{64}$',
      false
    )
    OR p_created_at IS NULL
    OR p_expires_at IS NULL
    OR NOT COALESCE(p_created_at < p_expires_at, false)
    OR NOT COALESCE((
      (
        p_scope_key = 'platform'
        AND p_workspace_id IS NULL
      ) OR (
        p_scope_key <> 'platform'
        AND p_workspace_id IS NOT NULL
        AND p_scope_key = p_workspace_id::text
      )
    ), false)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_privacy_class = 'PERSONAL_DATA' THEN
    IF p_scope_key = 'platform' OR p_workspace_id IS NULL THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    expected_object_key :=
      'generic-operation-results/v1/final/personal-data/ws/'
      || p_workspace_id::text
      || '/sha256/' || substring(p_sha256 from 1 for 2) || '/' || p_sha256;
  ELSE
    expected_object_key :=
      'generic-operation-results/v1/final/'
      || CASE p_privacy_class
        WHEN 'PUBLIC_ORGANIZATION' THEN 'public-organization'
        WHEN 'CONFIDENTIAL_TENANT' THEN 'confidential-tenant'
        ELSE NULL
      END
      || '/sha256/' || substring(p_sha256 from 1 for 2) || '/' || p_sha256;
  END IF;

  IF p_object_key IS DISTINCT FROM expected_object_key THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'generic-operation-artifact-operation:'
      || p_scope_key || ':' || p_operation_id::text,
      0
    )
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'generic-operation-artifact-object:' || expected_object_key,
      0
    )
  );

  SELECT artifact.* INTO existing
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = p_scope_key
    AND artifact."operation_id" = p_operation_id
  FOR UPDATE;

  IF existing."id" IS NOT NULL THEN
    IF existing."id" IS DISTINCT FROM p_artifact_id
      OR existing."scope_key" IS DISTINCT FROM p_scope_key
      OR existing."workspace_id" IS DISTINCT FROM p_workspace_id
      OR existing."authority_id" IS DISTINCT FROM p_authority_id
      OR existing."operation_id" IS DISTINCT FROM p_operation_id
      OR existing."result_schema" IS DISTINCT FROM p_result_schema
      OR existing."object_key" IS DISTINCT FROM p_object_key
      OR existing."sha256" IS DISTINCT FROM p_sha256
      OR existing."size_bytes" IS DISTINCT FROM p_size_bytes
      OR existing."media_type" IS DISTINCT FROM p_media_type
      OR existing."privacy_class" IS DISTINCT FROM p_privacy_class
      OR existing."source_digest" IS DISTINCT FROM p_source_digest
      OR existing."created_at" IS DISTINCT FROM p_created_at
      OR existing."expires_at" IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
      existing."id", existing."scope_key", existing."workspace_id",
      existing."authority_id", existing."operation_id",
      existing."result_schema", existing."object_key", existing."sha256",
      existing."size_bytes", existing."media_type",
      existing."privacy_class", existing."source_digest",
      existing."created_at", existing."expires_at", true;
    RETURN;
  END IF;

  SELECT
    operation."id" AS operation_id,
    operation."status" AS operation_status,
    account."authority_id" AS authority_id,
    authority."authority_kind" AS authority_kind,
    authority."workspace_id" AS authority_workspace_id
  INTO bound_operation
  FROM "tool_budget_operation" operation
  JOIN "tool_budget_account" account
    ON account."scope_key" = operation."scope_key"
   AND account."id" = operation."account_id"
  JOIN "execution_budget_authority" authority
    ON authority."scope_key" = account."scope_key"
   AND authority."id" = account."authority_id"
  WHERE operation."scope_key" = p_scope_key
    AND operation."id" = p_operation_id
    AND account."authority_id" = p_authority_id
    AND authority."id" = p_authority_id
  FOR UPDATE OF operation, account, authority;

  IF bound_operation.operation_id IS NULL
    OR bound_operation.operation_status NOT IN ('RESERVED', 'RESULT_UNKNOWN')
    OR bound_operation.authority_id IS DISTINCT FROM p_authority_id
    OR NOT COALESCE((
      (
        p_scope_key = 'platform'
        AND bound_operation.authority_kind = 'PLATFORM_GRANT'
        AND bound_operation.authority_workspace_id IS NULL
      ) OR (
        p_scope_key <> 'platform'
        AND bound_operation.authority_kind = 'WORKSPACE_GRANT'
        AND bound_operation.authority_workspace_id IS NOT DISTINCT FROM p_workspace_id
      )
    ), false)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "generic_operation_artifact_object"(
    "sha256", "object_key", "size_bytes", "media_type", "privacy_class"
  ) VALUES (
    p_sha256, p_object_key, p_size_bytes, p_media_type, p_privacy_class
  ) ON CONFLICT ON CONSTRAINT "generic_operation_artifact_object_pkey"
    DO NOTHING;

  SELECT object.* INTO bound_object
  FROM "generic_operation_artifact_object" object
  WHERE object."object_key" = p_object_key
  FOR UPDATE;

  IF bound_object."object_key" IS NULL
    OR bound_object."sha256" IS DISTINCT FROM p_sha256
    OR bound_object."size_bytes" IS DISTINCT FROM p_size_bytes
    OR bound_object."privacy_class" IS DISTINCT FROM p_privacy_class
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "generic_operation_artifact"(
    "id", "scope_key", "workspace_id", "authority_id", "operation_id",
    "result_schema", "object_key", "sha256", "size_bytes", "media_type",
    "privacy_class", "source_digest", "created_at", "expires_at"
  ) VALUES (
    p_artifact_id, p_scope_key, p_workspace_id, p_authority_id,
    p_operation_id, p_result_schema, p_object_key, p_sha256, p_size_bytes,
    p_media_type, p_privacy_class, p_source_digest, p_created_at, p_expires_at
  ) RETURNING * INTO stored;

  RETURN QUERY SELECT
    stored."id", stored."scope_key", stored."workspace_id",
    stored."authority_id", stored."operation_id", stored."result_schema",
    stored."object_key", stored."sha256", stored."size_bytes",
    stored."media_type", stored."privacy_class", stored."source_digest",
    stored."created_at", stored."expires_at", false;
END
$$;

CREATE OR REPLACE FUNCTION settle_tool_budget_artifact_manifest_v2(
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
SET search_path = pg_catalog, public, pg_temp
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
    OR NOT COALESCE(char_length(p_manifest->>'objectKey') BETWEEN 1 AND 200, false)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'generic-operation-artifact-operation:'
      || p_scope_key || ':' || p_operation_id::text,
      0
    )
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'generic-operation-artifact-object:' || (p_manifest->>'objectKey'),
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
    OR NOT COALESCE(char_length(p_manifest->>'objectKey') BETWEEN 1 AND 200, false)
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
    'generic-operation-artifact-object:'||(p_manifest->>'objectKey'),0));
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

CREATE OR REPLACE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v3(
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
  WHERE target."object_key" = artifact."object_key"
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

CREATE FUNCTION record_generic_operation_artifact_object_version_v2(
  p_object_key TEXT,
  p_sha256 TEXT,
  p_privacy_class TEXT,
  p_object_version_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF p_object_key IS NULL
    OR char_length(p_object_key) NOT BETWEEN 1 AND 200
    OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
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
  WHERE target."object_key" = p_object_key
    AND target."sha256" = p_sha256
    AND target."privacy_class" = p_privacy_class;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "generic_operation_artifact_object_version" (
    "object_key", "sha256", "privacy_class", "object_version_id"
  ) VALUES (p_object_key, p_sha256, p_privacy_class, p_object_version_id)
  ON CONFLICT ON CONSTRAINT "generic_operation_artifact_object_version_pkey"
    DO NOTHING;
END
$$;

REVOKE ALL ON FUNCTION
  record_generic_operation_artifact_object_version_v2(TEXT, TEXT, TEXT, TEXT)
FROM PUBLIC, app_user, execution_budget_platform_writer;

CREATE OR REPLACE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v4(
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
  PERFORM record_generic_operation_artifact_object_version_v2(
    artifact."object_key", artifact."sha256", artifact."privacy_class",
    p_object_version_id
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

CREATE OR REPLACE FUNCTION enforce_personal_artifact_object_version_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."privacy_class" = 'PERSONAL_DATA' AND NOT EXISTS (
    SELECT 1 FROM "generic_operation_artifact_object" object
    WHERE object."object_key" = NEW."object_key"
      AND object."object_version_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_OBJECT_VERSION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION enforce_personal_artifact_cleanup_binding_fence_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE artifact_object_key TEXT;
BEGIN
  SELECT artifact."object_key" INTO artifact_object_key
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = NEW."scope_key"
    AND artifact."id" = NEW."artifact_id";
  IF artifact_object_key IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-object:' || artifact_object_key, 0
  ));
  IF EXISTS (
    SELECT 1 FROM "personal_artifact_cleanup_command" cleanup
    WHERE cleanup."object_key" = artifact_object_key
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

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
  key_row RECORD;
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

  FOR key_row IN
    SELECT DISTINCT artifact."object_key"
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact" artifact
      ON artifact."scope_key" = subject."scope_key"
     AND artifact."id" = subject."artifact_id"
    WHERE subject."workspace_id" = audit_row."workspace_id"
      AND subject."subject_type" = audit_row."subject_type"
      AND subject."subject_id" = audit_row."subject_id"
    ORDER BY artifact."object_key"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'generic-operation-artifact-object:' || key_row."object_key", 0
    ));
  END LOOP;

  WITH subject_objects AS (
    SELECT DISTINCT artifact."object_key"
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
    WHERE shared_artifact."object_key" = candidate."object_key"
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
    SELECT DISTINCT artifact."object_key"
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
    ON object."object_key" = candidate."object_key"
  WHERE object."object_version_id" IS NULL;

  WITH eligible_objects AS (
    SELECT artifact."object_key",
      min(artifact."sha256") AS sha256,
      min(artifact."id"::text)::UUID AS artifact_id
    FROM "generic_operation_artifact_subject" subject
    JOIN "generic_operation_artifact" artifact
      ON artifact."scope_key" = subject."scope_key"
     AND artifact."id" = subject."artifact_id"
    JOIN "generic_operation_artifact_object" object
      ON object."object_key" = artifact."object_key"
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
        WHERE shared_artifact."object_key" = artifact."object_key"
          AND shared_artifact."privacy_class" = 'PERSONAL_DATA'
          AND NOT EXISTS (
            SELECT 1
            FROM "generic_operation_artifact_subject_tombstone" shared_tombstone
            WHERE shared_tombstone."workspace_id" = shared_subject."workspace_id"
              AND shared_tombstone."subject_type" = shared_subject."subject_type"
              AND shared_tombstone."subject_id" = shared_subject."subject_id"
          )
      )
    GROUP BY artifact."object_key"
  ), eligible AS (
    SELECT candidate."object_key", candidate."sha256", candidate.artifact_id,
      known."object_version_id"
    FROM eligible_objects candidate
    JOIN LATERAL (
      SELECT ledger."object_version_id"
      FROM "generic_operation_artifact_object_version" ledger
      WHERE ledger."object_key" = candidate."object_key"
      UNION
      SELECT object."object_version_id"
      FROM "generic_operation_artifact_object" object
      WHERE object."object_key" = candidate."object_key"
        AND object."object_version_id" IS NOT NULL
    ) known ON true
  ), inserted AS (
    INSERT INTO "personal_artifact_cleanup_command"(
      "workspace_id", "deletion_request_id", "artifact_id", "object_key",
      "sha256", "object_version_id", "tombstoned_at"
    )
    SELECT p_workspace_id, p_deletion_request_id, eligible.artifact_id,
      eligible."object_key", eligible."sha256", eligible."object_version_id",
      audit_row."tombstoned_at"
    FROM eligible
    ON CONFLICT ON CONSTRAINT
      "personal_artifact_cleanup_command_request_object_key" DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO inserted_count FROM inserted;
  RETURN QUERY SELECT inserted_count, shared_count, missing_version_count;
END
$$;

CREATE OR REPLACE FUNCTION inspect_workspace_personal_artifact_cleanup_v1(
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
    SELECT DISTINCT artifact."object_key"
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
    WHERE shared_artifact."object_key" = candidate."object_key"
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
    SELECT DISTINCT artifact."object_key"
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
    ON object."object_key" = candidate."object_key"
  WHERE object."object_version_id" IS NULL;
  RETURN QUERY SELECT true, shared_count > 0, version_count > 0;
END
$$;

CREATE OR REPLACE FUNCTION claim_workspace_personal_artifact_cleanup_v1(
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
      'generic-operation-artifact-object:' || candidate."object_key", 0
    ));
    IF EXISTS (
      SELECT 1
      FROM "generic_operation_artifact" shared_artifact
      JOIN "generic_operation_artifact_subject" shared_subject
        ON shared_subject."scope_key" = shared_artifact."scope_key"
       AND shared_subject."artifact_id" = shared_artifact."id"
      WHERE shared_artifact."object_key" = candidate."object_key"
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
    IF FOUND THEN
      RETURN NEXT candidate;
      RETURN;
    END IF;
  END IF;
END
$$;

COMMIT;
