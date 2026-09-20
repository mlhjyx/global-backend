-- Move final generic-operation artifacts into privacy-class-specific physical
-- prefixes. The migration is intentionally fail-closed for any existing
-- artifact/object/cleanup state: moving S3 versions requires a separate,
-- checksum-verified operator procedure and cannot be inferred in PostgreSQL.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "generic_operation_artifact_object")
    OR EXISTS (SELECT 1 FROM "generic_operation_artifact")
    OR EXISTS (SELECT 1 FROM "personal_artifact_cleanup_command")
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_LAYOUT_MIGRATION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

ALTER TABLE "generic_operation_artifact_object"
  DROP CONSTRAINT "generic_operation_artifact_object_pkey",
  ADD CONSTRAINT "generic_operation_artifact_object_pkey"
    PRIMARY KEY ("sha256", "privacy_class");

ALTER TABLE "generic_operation_artifact_object"
  DROP CONSTRAINT "generic_operation_artifact_object_digest_key_check",
  ADD CONSTRAINT "generic_operation_artifact_object_digest_key_check" CHECK (
    "sha256" ~ '^[0-9a-f]{64}$'
    AND "object_key" =
      'generic-operation-results/v1/final/'
      || CASE "privacy_class"
        WHEN 'PUBLIC_ORGANIZATION' THEN 'public-organization'
        WHEN 'CONFIDENTIAL_TENANT' THEN 'confidential-tenant'
        WHEN 'PERSONAL_DATA' THEN 'personal-data'
        ELSE NULL
      END
      || '/sha256/' || substring("sha256" from 1 for 2) || '/' || "sha256"
  );

ALTER TABLE "generic_operation_artifact"
  DROP CONSTRAINT "generic_operation_artifact_digest_key_check",
  ADD CONSTRAINT "generic_operation_artifact_digest_key_check" CHECK (
    "sha256" ~ '^[0-9a-f]{64}$'
    AND "object_key" =
      'generic-operation-results/v1/final/'
      || CASE "privacy_class"
        WHEN 'PUBLIC_ORGANIZATION' THEN 'public-organization'
        WHEN 'CONFIDENTIAL_TENANT' THEN 'confidential-tenant'
        WHEN 'PERSONAL_DATA' THEN 'personal-data'
        ELSE NULL
      END
      || '/sha256/' || substring("sha256" from 1 for 2) || '/' || "sha256"
    AND ("source_digest" IS NULL OR "source_digest" ~ '^[0-9a-f]{64}$')
  );

-- Preserve every predecessor validation and privilege attribute while
-- replacing the one canonical-key expression. Exact-source assertions make
-- this forward migration fail if a future predecessor changes unexpectedly.
DO $migration$
DECLARE
  definition TEXT;
  old_fragment TEXT := $old$
    OR p_manifest->>'objectKey' IS DISTINCT FROM (
      'generic-operation-results/v1/sha256/'
      || left(p_manifest->>'sha256', 2) || '/'
      || (p_manifest->>'sha256')
    )$old$;
  new_fragment TEXT := $new$
    OR p_manifest->>'objectKey' IS DISTINCT FROM (
      'generic-operation-results/v1/final/'
      || CASE p_manifest->>'privacyClass'
        WHEN 'PUBLIC_ORGANIZATION' THEN 'public-organization'
        WHEN 'CONFIDENTIAL_TENANT' THEN 'confidential-tenant'
        WHEN 'PERSONAL_DATA' THEN 'personal-data'
        ELSE NULL
      END
      || '/sha256/' || left(p_manifest->>'sha256', 2) || '/'
      || (p_manifest->>'sha256')
    )$new$;
BEGIN
  SELECT pg_get_functiondef(
    'assert_generic_operation_artifact_manifest_v2(text,uuid,uuid,jsonb)'::regprocedure
  ) INTO STRICT definition;
  IF (
    length(definition) - length(replace(definition, old_fragment, ''))
  ) IS DISTINCT FROM length(old_fragment)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_ASSERTION_SOURCE_DRIFT'
      USING ERRCODE = 'P0001';
  END IF;
  definition := replace(definition, old_fragment, new_fragment);
  IF strpos(definition, new_fragment) = 0 THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_ASSERTION_REWRITE_FAILED'
      USING ERRCODE = 'P0001';
  END IF;
  EXECUTE definition;
END
$migration$;

DO $migration$
DECLARE
  definition TEXT;
  old_fragment TEXT := $old$
  expected_object_key :=
    'generic-operation-results/v1/sha256/'
    || substring(p_sha256 from 1 for 2) || '/' || p_sha256;$old$;
  new_fragment TEXT := $new$
  expected_object_key :=
    'generic-operation-results/v1/final/'
    || CASE p_privacy_class
      WHEN 'PUBLIC_ORGANIZATION' THEN 'public-organization'
      WHEN 'CONFIDENTIAL_TENANT' THEN 'confidential-tenant'
      WHEN 'PERSONAL_DATA' THEN 'personal-data'
      ELSE NULL
    END
    || '/sha256/' || substring(p_sha256 from 1 for 2) || '/' || p_sha256;$new$;
  old_lookup TEXT := $old$
  WHERE object."sha256" = p_sha256
  FOR UPDATE;$old$;
  new_lookup TEXT := $new$
  WHERE object."sha256" = p_sha256
    AND object."privacy_class" = p_privacy_class
  FOR UPDATE;$new$;
BEGIN
  SELECT pg_get_functiondef(
    'append_generic_operation_artifact_internal_v1(text,uuid,uuid,uuid,uuid,text,text,text,bigint,text,text,text,timestamptz,timestamptz)'::regprocedure
  ) INTO STRICT definition;
  IF (
    length(definition) - length(replace(definition, old_fragment, ''))
  ) IS DISTINCT FROM length(old_fragment)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_APPEND_SOURCE_DRIFT'
      USING ERRCODE = 'P0001';
  END IF;
  definition := replace(definition, old_fragment, new_fragment);
  IF strpos(definition, new_fragment) = 0 THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_APPEND_REWRITE_FAILED'
      USING ERRCODE = 'P0001';
  END IF;
  IF (
    length(definition) - length(replace(definition, old_lookup, ''))
  ) IS DISTINCT FROM length(old_lookup)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_APPEND_LOOKUP_SOURCE_DRIFT'
      USING ERRCODE = 'P0001';
  END IF;
  definition := replace(definition, old_lookup, new_lookup);
  EXECUTE definition;
END
$migration$;

-- Every database-side object lookup must include the privacy component of the
-- new physical identity. Rewrite only exact predecessor fragments and require
-- the complete expected replacement count before committing.
DO $migration$
DECLARE
  item RECORD;
  definition TEXT;
  rewritten TEXT;
  replacements INTEGER := 0;
  old_fragment TEXT;
  new_fragment TEXT;
BEGIN
  FOR item IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosrc LIKE '%generic_operation_artifact_object%'
  LOOP
    definition := pg_get_functiondef(item.oid);
    rewritten := definition;

    old_fragment := $old$
  WHERE target."sha256" = artifact."sha256"
    AND ($old$;
    new_fragment := $new$
  WHERE target."sha256" = artifact."sha256"
    AND target."privacy_class" = artifact."privacy_class"
    AND ($new$;
    replacements := replacements +
      ((length(rewritten) - length(replace(rewritten, old_fragment, '')))
        / length(old_fragment));
    rewritten := replace(rewritten, old_fragment, new_fragment);

    old_fragment := $old$
    WHERE object."sha256" = NEW."sha256"
      AND object."object_version_id" IS NOT NULL$old$;
    new_fragment := $new$
    WHERE object."sha256" = NEW."sha256"
      AND object."privacy_class" = NEW."privacy_class"
      AND object."object_version_id" IS NOT NULL$new$;
    replacements := replacements +
      ((length(rewritten) - length(replace(rewritten, old_fragment, '')))
        / length(old_fragment));
    rewritten := replace(rewritten, old_fragment, new_fragment);

    old_fragment := $old$
    ON object."sha256" = candidate."sha256"
  WHERE object."object_version_id" IS NULL$old$;
    new_fragment := $new$
    ON object."sha256" = candidate."sha256"
   AND object."privacy_class" = 'PERSONAL_DATA'
  WHERE object."object_version_id" IS NULL$new$;
    replacements := replacements +
      ((length(rewritten) - length(replace(rewritten, old_fragment, '')))
        / length(old_fragment));
    rewritten := replace(rewritten, old_fragment, new_fragment);

    old_fragment := $old$
      ON object."sha256" = artifact."sha256"
    WHERE subject."workspace_id"$old$;
    new_fragment := $new$
      ON object."sha256" = artifact."sha256"
     AND object."privacy_class" = artifact."privacy_class"
    WHERE subject."workspace_id"$new$;
    replacements := replacements +
      ((length(rewritten) - length(replace(rewritten, old_fragment, '')))
        / length(old_fragment));
    rewritten := replace(rewritten, old_fragment, new_fragment);

    IF rewritten IS DISTINCT FROM definition THEN
      EXECUTE rewritten;
    END IF;
  END LOOP;

  IF replacements <> 5 THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_OBJECT_IDENTITY_SOURCE_DRIFT'
      USING ERRCODE = 'P0001';
  END IF;
END
$migration$;

COMMIT;
