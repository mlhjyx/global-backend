-- Additive immutable manifest metadata for large durable Tool results.
-- Object bytes remain outside PostgreSQL at a digest-derived immutable key.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

ALTER TABLE "tool_budget_operation"
  ADD CONSTRAINT "tool_budget_operation_scope_id_key"
  UNIQUE ("scope_key", "id");

CREATE TABLE "generic_operation_artifact" (
  "id" UUID NOT NULL,
  "scope_key" VARCHAR(200) NOT NULL,
  "workspace_id" UUID,
  "authority_id" UUID NOT NULL,
  "operation_id" UUID NOT NULL,
  "result_schema" VARCHAR(100) NOT NULL,
  "object_key" VARCHAR(200) NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "media_type" VARCHAR(160) NOT NULL,
  "privacy_class" VARCHAR(40) NOT NULL,
  "source_digest" CHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "generic_operation_artifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "generic_operation_artifact_scope_id_key"
    UNIQUE ("scope_key", "id"),
  CONSTRAINT "generic_operation_artifact_scope_operation_key"
    UNIQUE ("scope_key", "operation_id"),
  CONSTRAINT "generic_operation_artifact_scope_digest_schema_key"
    UNIQUE ("scope_key", "sha256", "result_schema"),
  CONSTRAINT "generic_operation_artifact_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "generic_operation_artifact_authority_scope_fkey"
    FOREIGN KEY ("scope_key", "authority_id")
    REFERENCES "execution_budget_authority"("scope_key", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "generic_operation_artifact_operation_scope_fkey"
    FOREIGN KEY ("scope_key", "operation_id")
    REFERENCES "tool_budget_operation"("scope_key", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "generic_operation_artifact_scope_shape_check" CHECK (
    (
      "scope_key" = 'platform'
      AND "workspace_id" IS NULL
    ) OR (
      "scope_key" <> 'platform'
      AND "workspace_id" IS NOT NULL
      AND "scope_key" = "workspace_id"::text
    )
  ),
  CONSTRAINT "generic_operation_artifact_result_schema_check" CHECK (
    char_length("result_schema") BETWEEN 1 AND 100
    AND "result_schema" ~ '^[a-z0-9][a-z0-9._/-]*$'
  ),
  CONSTRAINT "generic_operation_artifact_digest_key_check" CHECK (
    "sha256" ~ '^[0-9a-f]{64}$'
    AND "object_key" =
      'generic-operation-results/v1/sha256/'
      || substring("sha256" from 1 for 2) || '/' || "sha256"
    AND (
      "source_digest" IS NULL
      OR "source_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "generic_operation_artifact_metadata_check" CHECK (
    "size_bytes" >= 0
    AND "media_type" ~
      '^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$'
    AND "privacy_class" IN (
      'PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT', 'PERSONAL_DATA'
    )
    AND "created_at" < "expires_at"
  )
);

CREATE INDEX "generic_operation_artifact_scope_authority_operation_idx"
  ON "generic_operation_artifact"(
    "scope_key", "authority_id", "operation_id"
  );
CREATE INDEX "generic_operation_artifact_workspace_expiry_idx"
  ON "generic_operation_artifact"("workspace_id", "expires_at");
CREATE INDEX "generic_operation_artifact_privacy_expiry_idx"
  ON "generic_operation_artifact"("privacy_class", "expires_at");

ALTER TABLE "generic_operation_artifact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generic_operation_artifact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "generic_operation_artifact_scope_isolation"
  ON "generic_operation_artifact"
  USING (
    (
      "workspace_id" IS NOT NULL
      AND session_user = 'app_user'
      AND current_setting('role', true) IS NOT DISTINCT FROM 'none'
      AND "scope_key" = current_workspace_id()::text
      AND "workspace_id" IS NOT DISTINCT FROM current_workspace_id()
    ) OR (
      "workspace_id" IS NULL
      AND "scope_key" = 'platform'
      AND pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
    )
  )
  WITH CHECK (
    (
      "workspace_id" IS NOT NULL
      AND session_user = 'app_user'
      AND current_setting('role', true) IS NOT DISTINCT FROM 'none'
      AND "scope_key" = current_workspace_id()::text
      AND "workspace_id" IS NOT DISTINCT FROM current_workspace_id()
    ) OR (
      "workspace_id" IS NULL
      AND "scope_key" = 'platform'
      AND pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
    )
  );

CREATE FUNCTION append_generic_operation_artifact_internal_v1(
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing "generic_operation_artifact"%ROWTYPE;
  stored "generic_operation_artifact"%ROWTYPE;
  bound_operation RECORD;
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

  expected_object_key :=
    'generic-operation-results/v1/sha256/'
    || substring(p_sha256 from 1 for 2) || '/' || p_sha256;
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
      'generic-operation-artifact-digest:'
      || p_scope_key || ':' || p_sha256 || ':' || p_result_schema,
      0
    )
  );

  SELECT artifact.* INTO existing
  FROM "generic_operation_artifact" artifact
  WHERE (
    artifact."scope_key" = p_scope_key
    AND artifact."operation_id" = p_operation_id
  ) OR (
    artifact."scope_key" = p_scope_key
    AND artifact."sha256" = p_sha256
    AND artifact."result_schema" = p_result_schema
  )
  ORDER BY artifact."id"
  LIMIT 1
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
    OR bound_operation.operation_status IS DISTINCT FROM 'RESERVED'
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

CREATE FUNCTION append_workspace_generic_operation_artifact_v1(
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
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3), replay BOOLEAN
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
  FROM append_generic_operation_artifact_internal_v1(
    p_workspace_id::text, p_workspace_id, p_artifact_id, p_authority_id,
    p_operation_id, p_result_schema, p_object_key, p_sha256, p_size_bytes,
    p_media_type, p_privacy_class, p_source_digest, p_created_at, p_expires_at
  );
END
$$;

CREATE FUNCTION append_platform_generic_operation_artifact_v1(
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
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3), replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  RETURN QUERY SELECT *
  FROM append_generic_operation_artifact_internal_v1(
    'platform', NULL, p_artifact_id, p_authority_id, p_operation_id,
    p_result_schema, p_object_key, p_sha256, p_size_bytes, p_media_type,
    p_privacy_class, p_source_digest, p_created_at, p_expires_at
  );
END
$$;

CREATE FUNCTION find_exact_workspace_generic_operation_artifact_v1(
  p_workspace_id UUID,
  p_artifact_id UUID,
  p_authority_id UUID,
  p_operation_id UUID,
  p_result_schema TEXT,
  p_sha256 TEXT,
  p_size_bytes BIGINT,
  p_media_type TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE(
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3)
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
    OR p_artifact_id IS NULL
    OR p_authority_id IS NULL
    OR p_operation_id IS NULL
    OR p_result_schema IS NULL
    OR p_sha256 IS NULL
    OR p_size_bytes IS NULL
    OR p_media_type IS NULL
    OR p_expires_at IS NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT
    artifact."id", artifact."scope_key", artifact."workspace_id",
    artifact."authority_id", artifact."operation_id",
    artifact."result_schema", artifact."object_key", artifact."sha256",
    artifact."size_bytes", artifact."media_type", artifact."privacy_class",
    artifact."source_digest", artifact."created_at", artifact."expires_at"
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = p_workspace_id::text
    AND artifact."workspace_id" = p_workspace_id
    AND artifact."id" = p_artifact_id
    AND artifact."authority_id" = p_authority_id
    AND artifact."operation_id" = p_operation_id
    AND artifact."result_schema" = p_result_schema
    AND artifact."sha256" = p_sha256
    AND artifact."size_bytes" = p_size_bytes
    AND artifact."media_type" = p_media_type
    AND artifact."expires_at" = p_expires_at;
END
$$;

CREATE FUNCTION find_exact_platform_generic_operation_artifact_v1(
  p_artifact_id UUID,
  p_authority_id UUID,
  p_operation_id UUID,
  p_result_schema TEXT,
  p_sha256 TEXT,
  p_size_bytes BIGINT,
  p_media_type TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE(
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_artifact_id IS NULL
    OR p_authority_id IS NULL
    OR p_operation_id IS NULL
    OR p_result_schema IS NULL
    OR p_sha256 IS NULL
    OR p_size_bytes IS NULL
    OR p_media_type IS NULL
    OR p_expires_at IS NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT
    artifact."id", artifact."scope_key", artifact."workspace_id",
    artifact."authority_id", artifact."operation_id",
    artifact."result_schema", artifact."object_key", artifact."sha256",
    artifact."size_bytes", artifact."media_type", artifact."privacy_class",
    artifact."source_digest", artifact."created_at", artifact."expires_at"
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = 'platform'
    AND artifact."workspace_id" IS NULL
    AND artifact."id" = p_artifact_id
    AND artifact."authority_id" = p_authority_id
    AND artifact."operation_id" = p_operation_id
    AND artifact."result_schema" = p_result_schema
    AND artifact."sha256" = p_sha256
    AND artifact."size_bytes" = p_size_bytes
    AND artifact."media_type" = p_media_type
    AND artifact."expires_at" = p_expires_at;
END
$$;

CREATE FUNCTION find_workspace_generic_operation_artifact_by_operation_v1(
  p_workspace_id UUID,
  p_authority_id UUID,
  p_operation_id UUID,
  p_result_schema TEXT
)
RETURNS TABLE(
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3)
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
    OR p_authority_id IS NULL
    OR p_operation_id IS NULL
    OR p_result_schema IS NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT
    artifact."id", artifact."scope_key", artifact."workspace_id",
    artifact."authority_id", artifact."operation_id",
    artifact."result_schema", artifact."object_key", artifact."sha256",
    artifact."size_bytes", artifact."media_type", artifact."privacy_class",
    artifact."source_digest", artifact."created_at", artifact."expires_at"
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = p_workspace_id::text
    AND artifact."workspace_id" = p_workspace_id
    AND artifact."authority_id" = p_authority_id
    AND artifact."operation_id" = p_operation_id
    AND artifact."result_schema" = p_result_schema;
END
$$;

CREATE FUNCTION find_platform_generic_operation_artifact_by_operation_v1(
  p_authority_id UUID,
  p_operation_id UUID,
  p_result_schema TEXT
)
RETURNS TABLE(
  artifact_id UUID, scope_key VARCHAR(200), workspace_id UUID,
  authority_id UUID, operation_id UUID, result_schema VARCHAR(100),
  object_key VARCHAR(200), sha256 CHAR(64), size_bytes BIGINT,
  media_type VARCHAR(160), privacy_class VARCHAR(40), source_digest CHAR(64),
  created_at TIMESTAMPTZ(3), expires_at TIMESTAMPTZ(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_authority_id IS NULL
    OR p_operation_id IS NULL
    OR p_result_schema IS NULL
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT
    artifact."id", artifact."scope_key", artifact."workspace_id",
    artifact."authority_id", artifact."operation_id",
    artifact."result_schema", artifact."object_key", artifact."sha256",
    artifact."size_bytes", artifact."media_type", artifact."privacy_class",
    artifact."source_digest", artifact."created_at", artifact."expires_at"
  FROM "generic_operation_artifact" artifact
  WHERE artifact."scope_key" = 'platform'
    AND artifact."workspace_id" IS NULL
    AND artifact."authority_id" = p_authority_id
    AND artifact."operation_id" = p_operation_id
    AND artifact."result_schema" = p_result_schema;
END
$$;

REVOKE ALL ON TABLE "generic_operation_artifact" FROM PUBLIC;
REVOKE ALL ON TABLE "generic_operation_artifact" FROM app_user;
REVOKE ALL ON TABLE "generic_operation_artifact"
  FROM execution_budget_platform_writer;

REVOKE ALL ON FUNCTION
  append_generic_operation_artifact_internal_v1(
    TEXT, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
    TEXT, TIMESTAMPTZ, TIMESTAMPTZ
  ),
  append_workspace_generic_operation_artifact_v1(
    UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
    TIMESTAMPTZ, TIMESTAMPTZ
  ),
  append_platform_generic_operation_artifact_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
    TIMESTAMPTZ, TIMESTAMPTZ
  ),
  find_exact_workspace_generic_operation_artifact_v1(
    UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
  ),
  find_exact_platform_generic_operation_artifact_v1(
    UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
  ),
  find_workspace_generic_operation_artifact_by_operation_v1(
    UUID, UUID, UUID, TEXT
  ),
  find_platform_generic_operation_artifact_by_operation_v1(
    UUID, UUID, TEXT
  )
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  append_generic_operation_artifact_internal_v1(
    TEXT, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
    TEXT, TIMESTAMPTZ, TIMESTAMPTZ
  ),
  append_platform_generic_operation_artifact_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
    TIMESTAMPTZ, TIMESTAMPTZ
  ),
  find_exact_platform_generic_operation_artifact_v1(
    UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
  ),
  find_platform_generic_operation_artifact_by_operation_v1(
    UUID, UUID, TEXT
  )
FROM app_user;

REVOKE EXECUTE ON FUNCTION
  append_generic_operation_artifact_internal_v1(
    TEXT, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
    TEXT, TIMESTAMPTZ, TIMESTAMPTZ
  ),
  append_workspace_generic_operation_artifact_v1(
    UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
    TIMESTAMPTZ, TIMESTAMPTZ
  ),
  find_exact_workspace_generic_operation_artifact_v1(
    UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
  ),
  find_workspace_generic_operation_artifact_by_operation_v1(
    UUID, UUID, UUID, TEXT
  )
FROM execution_budget_platform_writer;

GRANT EXECUTE ON FUNCTION
  append_workspace_generic_operation_artifact_v1(
    UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
    TIMESTAMPTZ, TIMESTAMPTZ
  ),
  find_exact_workspace_generic_operation_artifact_v1(
    UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
  ),
  find_workspace_generic_operation_artifact_by_operation_v1(
    UUID, UUID, UUID, TEXT
  )
TO app_user;

GRANT EXECUTE ON FUNCTION
  append_platform_generic_operation_artifact_v1(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
    TIMESTAMPTZ, TIMESTAMPTZ
  ),
  find_exact_platform_generic_operation_artifact_v1(
    UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
  ),
  find_platform_generic_operation_artifact_by_operation_v1(
    UUID, UUID, TEXT
  )
TO execution_budget_platform_writer;

COMMIT;
