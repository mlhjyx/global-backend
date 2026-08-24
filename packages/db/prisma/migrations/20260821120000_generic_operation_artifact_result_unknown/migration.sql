-- Preserve a full reservation when an artifact write acknowledgement is
-- unknown, and allow only fact recovery into the final immutable reference.

-- PostgreSQL does not permit a newly added enum value to be referenced until
-- the transaction that adds it commits. This idempotent statement therefore
-- forms the first migration phase; every following state change is atomic.
ALTER TYPE "tool_budget_operation_status"
  ADD VALUE IF NOT EXISTS 'RESULT_UNKNOWN' AFTER 'RESERVED';

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

ALTER TABLE "tool_budget_operation"
  ALTER COLUMN "result_schema" TYPE VARCHAR(100);

ALTER TABLE "tool_budget_operation"
  DROP CONSTRAINT "tool_budget_operation_status_shape_check",
  ADD CONSTRAINT "tool_budget_operation_status_shape_check" CHECK (
    (
      "status" IN ('RESERVED', 'RESULT_UNKNOWN')
      AND "observed_cents" IS NULL
      AND "charged_cents" IS NULL
      AND "settled_at" IS NULL
    ) OR (
      "status" IN ('SETTLED', 'RELEASED')
      AND "observed_cents" IS NOT NULL
      AND "charged_cents" IS NOT NULL
      AND "settled_at" IS NOT NULL
    )
  );

ALTER TABLE "tool_budget_operation"
  DROP CONSTRAINT "tool_budget_operation_result_shape_check",
  ADD CONSTRAINT "tool_budget_operation_result_shape_check" CHECK (
    (
      "result_schema_version" IS NULL
      AND "result_schema" IS NULL
      AND "result_digest" IS NULL
      AND "result_json" IS NULL
    ) OR (
      "status" = 'SETTLED'
      AND "result_schema_version" IS NOT NULL
      AND "result_schema" IS NOT NULL
      AND "result_digest" IS NOT NULL
      AND "result_json" IS NOT NULL
      AND octet_length("result_json"::text) <= 131072
      AND (
        (
          "result_schema_version" = 'generic-operation-projection/v1'
          AND "result_schema" ~
            '^[a-z][a-z0-9_-]{1,63}/v[1-9][0-9]{0,3}$'
          AND "result_digest" ~ '^[0-9a-f]{64}$'
        ) OR (
          "result_schema_version" = 'generic-operation-artifact-ref/v1'
          AND "result_schema" ~ '^[a-z0-9][a-z0-9._/-]*$'
          AND "result_digest" ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof("result_json") = 'object'
          AND "result_json" ?& ARRAY[
            'schemaVersion', 'artifactId', 'operationId', 'resultSchema',
            'sha256', 'sizeBytes', 'mediaType', 'expiresAt'
          ]
          AND (
            "result_json" - ARRAY[
              'schemaVersion', 'artifactId', 'operationId', 'resultSchema',
              'sha256', 'sizeBytes', 'mediaType', 'expiresAt'
            ]
          ) = '{}'::jsonb
          AND "result_json"->>'schemaVersion'
            = 'generic-operation-artifact-ref/v1'
          AND "result_json"->>'operationId' = "id"::text
          AND "result_json"->>'resultSchema' = "result_schema"
          AND "result_json"->>'sha256' = "result_digest"
        )
      )
    )
  );

-- Task 2 is already committed. Replace only the exact status predicate in its
-- internal append function; fail migration rather than silently accepting an
-- unknown predecessor definition. All other validation, RLS/principal checks,
-- locks, object metadata coherence, and append-only behavior remain identical.
DO $migration$
DECLARE
  prior_definition TEXT;
  old_predicate CONSTANT TEXT :=
    'bound_operation.operation_status IS DISTINCT FROM ''RESERVED''';
  new_predicate CONSTANT TEXT :=
    'bound_operation.operation_status NOT IN (''RESERVED'', ''RESULT_UNKNOWN'')';
BEGIN
  prior_definition := pg_get_functiondef(
    'append_generic_operation_artifact_internal_v1(text,uuid,uuid,uuid,uuid,text,text,text,bigint,text,text,text,timestamptz,timestamptz)'::regprocedure
  );
  IF prior_definition IS NULL
    OR position(old_predicate IN prior_definition) = 0
    OR position(new_predicate IN prior_definition) > 0
    OR length(prior_definition) - length(replace(prior_definition, old_predicate, ''))
      <> length(old_predicate)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_MIGRATION_PREDECESSOR_INVALID';
  END IF;
  EXECUTE replace(prior_definition, old_predicate, new_predicate);
END
$migration$;

CREATE FUNCTION guard_tool_budget_unresolved_generation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."generation" IS DISTINCT FROM OLD."generation"
    AND EXISTS (
      SELECT 1
      FROM "tool_budget_operation" operation
      WHERE operation."scope_key" = OLD."scope_key"
        AND operation."account_id" = OLD."id"
        AND operation."generation" = OLD."generation"
        AND operation."status" IN ('RESERVED', 'RESULT_UNKNOWN')
    )
  THEN
    RAISE EXCEPTION 'TOOL_BUDGET_UNSETTLED_OPERATIONS'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "tool_budget_account_unresolved_generation_guard"
BEFORE UPDATE OF "generation" ON "tool_budget_account"
FOR EACH ROW
EXECUTE FUNCTION guard_tool_budget_unresolved_generation_v1();

CREATE FUNCTION mark_tool_budget_result_unknown_v1(
  p_scope_key TEXT,
  p_operation_id UUID
)
RETURNS TABLE(
  reserved_cents BIGINT,
  status TEXT,
  replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
  authority_id UUID;
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
  SELECT account."authority_id" INTO authority_id
  FROM "tool_budget_account" account
  WHERE account."scope_key" = p_scope_key
    AND account."id" = operation."account_id"
  FOR UPDATE;

  IF operation."id" IS NULL
    OR authority_id IS NULL
    OR operation."result_schema_version" IS NOT NULL
    OR operation."result_schema" IS NOT NULL
    OR operation."result_digest" IS NOT NULL
    OR operation."result_json" IS NOT NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF operation."status" = 'RESERVED' THEN
    UPDATE "tool_budget_operation" target
    SET "status" = 'RESULT_UNKNOWN'
    WHERE target."scope_key" = p_scope_key
      AND target."id" = p_operation_id
    RETURNING target.* INTO operation;
    RETURN QUERY SELECT operation."reserved_cents", operation."status"::text, false;
    RETURN;
  END IF;
  IF operation."status" = 'RESULT_UNKNOWN' THEN
    RETURN QUERY SELECT operation."reserved_cents", operation."status"::text, true;
    RETURN;
  END IF;
  RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
    USING ERRCODE = 'P0001';
END
$$;

CREATE FUNCTION settle_tool_budget_artifact_reference_v1(
  p_scope_key TEXT,
  p_operation_id UUID,
  p_observed_cents BIGINT,
  p_reference JSONB
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
  artifact "generic_operation_artifact"%ROWTYPE;
  parsed_size BIGINT;
  parsed_expiry TIMESTAMPTZ;
BEGIN
  IF p_scope_key IS NULL
    OR p_operation_id IS NULL
    OR p_observed_cents IS NULL
    OR p_observed_cents < 0
    OR jsonb_typeof(p_reference) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_reference)) <> 8
    OR p_reference->>'schemaVersion'
      IS DISTINCT FROM 'generic-operation-artifact-ref/v1'
    OR NOT COALESCE(
      (p_reference->>'artifactId') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      false
    )
    OR NOT COALESCE(
      (p_reference->>'operationId') = p_operation_id::text,
      false
    )
    OR NOT COALESCE(
      char_length(p_reference->>'resultSchema') BETWEEN 1 AND 100
      AND (p_reference->>'resultSchema') ~ '^[a-z0-9][a-z0-9._/-]*$',
      false
    )
    OR NOT COALESCE((p_reference->>'sha256') ~ '^[0-9a-f]{64}$', false)
    OR NOT COALESCE(
      (p_reference->>'sizeBytes') ~ '^(0|[1-9][0-9]{0,18})$',
      false
    )
    OR NOT COALESCE(
      char_length(p_reference->>'mediaType') <= 160
      AND (p_reference->>'mediaType') ~
        '^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$',
      false
    )
    OR NOT COALESCE(
      (p_reference->>'expiresAt') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$',
      false
    )
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    parsed_size := (p_reference->>'sizeBytes')::BIGINT;
    parsed_expiry := (p_reference->>'expiresAt')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END;
  IF to_char(
    parsed_expiry AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) IS DISTINCT FROM p_reference->>'expiresAt' THEN
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
  SELECT budget.* INTO account
  FROM "tool_budget_account" budget
  WHERE budget."scope_key" = p_scope_key
    AND budget."id" = operation."account_id"
  FOR UPDATE;

  IF operation."id" IS NULL OR account."authority_id" IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF operation."status" = 'SETTLED' THEN
    IF operation."observed_cents" IS DISTINCT FROM p_observed_cents
      OR operation."result_schema_version"
        IS DISTINCT FROM 'generic-operation-artifact-ref/v1'
      OR operation."result_schema"
        IS DISTINCT FROM p_reference->>'resultSchema'
      OR operation."result_digest" IS DISTINCT FROM p_reference->>'sha256'
      OR operation."result_json" IS DISTINCT FROM p_reference
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT
      operation."charged_cents", operation."observed_cents",
      operation."observed_cents" > operation."reserved_cents",
      operation."status"::text, true;
    RETURN;
  END IF;

  IF operation."status" NOT IN ('RESERVED', 'RESULT_UNKNOWN') THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO artifact
  FROM "generic_operation_artifact" target
  WHERE target."scope_key" = p_scope_key
    AND target."operation_id" = p_operation_id
    AND target."authority_id" = account."authority_id"
    AND target."id" = (p_reference->>'artifactId')::UUID
    AND target."result_schema" = p_reference->>'resultSchema'
    AND target."sha256" = p_reference->>'sha256'
    AND target."size_bytes" = parsed_size
    AND target."media_type" = p_reference->>'mediaType'
    AND target."expires_at" = parsed_expiry
  FOR SHARE;
  IF artifact."id" IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE "tool_budget_operation" target
  SET "observed_cents" = p_observed_cents,
      "charged_cents" = operation."reserved_cents",
      "status" = 'SETTLED',
      "result_schema_version" = 'generic-operation-artifact-ref/v1',
      "result_schema" = p_reference->>'resultSchema',
      "result_digest" = p_reference->>'sha256',
      "result_json" = p_reference,
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
  guard_tool_budget_unresolved_generation_v1(),
  mark_tool_budget_result_unknown_v1(TEXT, UUID),
  settle_tool_budget_artifact_reference_v1(TEXT, UUID, BIGINT, JSONB)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  mark_tool_budget_result_unknown_v1(TEXT, UUID),
  settle_tool_budget_artifact_reference_v1(TEXT, UUID, BIGINT, JSONB)
TO app_user;

GRANT EXECUTE ON FUNCTION
  mark_tool_budget_result_unknown_v1(TEXT, UUID),
  settle_tool_budget_artifact_reference_v1(TEXT, UUID, BIGINT, JSONB)
TO execution_budget_platform_writer;

COMMIT;
