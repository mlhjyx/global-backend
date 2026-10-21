-- An artifact object row is content-addressed: one row per (sha256, privacy
-- class), shared by every artifact whose bytes are identical. Its media type is
-- whatever the first writer declared; each artifact row keeps its own.
--
-- append_generic_operation_artifact_internal_v1 still compared the bound
-- object's media type with the incoming one, so bytes first written under one
-- media type could never be bound under another. The empty object was first
-- written by a crawl4ai-fetch/v1 result as text/markdown (xin, 2026-10-12); every
-- empty http-get/v1 HEAD probe after it (text/plain) was refused with
-- GENERIC_OPERATION_ARTIFACT_INVALID, became an unreplayable operation, and
-- signal enrichment lost companies to it until the stage failed (run c6b09756,
-- 2026-10-20). #644 already dropped the media type from the storage-side
-- equality of shared objects; this does the same in the database.
--
-- The same binding was also structural: the artifact table referenced the
-- object row through a foreign key that included media_type. The key moves to
-- the content columns (sha256, object key, size, privacy class), which is what
-- the object's primary key and storage key already identify; the artifact row
-- keeps its own media_type column and constraint. New constraints are added
-- before the old ones are dropped, so every intermediate state stays checked.
--
-- The function rewrite removes only the media type comparison. The object key,
-- size and privacy class must still match, and an artifact that already exists
-- must still match its own media type exactly.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

-- Take both tables up front in the order the append function locks them
-- (artifact, then object), so a settlement that started first cannot form a
-- lock cycle with the DDL below; anything still holding them fails this
-- migration after 5 s instead of queueing behind it forever.
LOCK TABLE "generic_operation_artifact", "generic_operation_artifact_object"
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "generic_operation_artifact_object"
  ADD CONSTRAINT "generic_operation_artifact_object_content_key"
  UNIQUE ("sha256", "object_key", "size_bytes", "privacy_class");

ALTER TABLE "generic_operation_artifact"
  ADD CONSTRAINT "generic_operation_artifact_object_content_fkey"
  FOREIGN KEY ("sha256", "object_key", "size_bytes", "privacy_class")
  REFERENCES "generic_operation_artifact_object"("sha256", "object_key", "size_bytes", "privacy_class")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "generic_operation_artifact"
  DROP CONSTRAINT "generic_operation_artifact_object_metadata_fkey";

ALTER TABLE "generic_operation_artifact_object"
  DROP CONSTRAINT "generic_operation_artifact_object_metadata_key";

DO $migration$
DECLARE
  definition TEXT;
  old_fragment TEXT := $old$
    OR bound_object."size_bytes" IS DISTINCT FROM p_size_bytes
    OR bound_object."media_type" IS DISTINCT FROM p_media_type
    OR bound_object."privacy_class" IS DISTINCT FROM p_privacy_class$old$;
  new_fragment TEXT := $new$
    OR bound_object."size_bytes" IS DISTINCT FROM p_size_bytes
    OR bound_object."privacy_class" IS DISTINCT FROM p_privacy_class$new$;
BEGIN
  SELECT pg_get_functiondef(
    'append_generic_operation_artifact_internal_v1(text,uuid,uuid,uuid,uuid,text,text,text,bigint,text,text,text,timestamptz,timestamptz)'::regprocedure
  ) INTO STRICT definition;
  IF (
    length(definition) - length(replace(definition, old_fragment, ''))
  ) IS DISTINCT FROM length(old_fragment)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_APPEND_OBJECT_MEDIA_TYPE_SOURCE_DRIFT'
      USING ERRCODE = 'P0001';
  END IF;
  definition := replace(definition, old_fragment, new_fragment);
  IF strpos(definition, 'bound_object."media_type"') <> 0 THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_APPEND_OBJECT_MEDIA_TYPE_REWRITE_FAILED'
      USING ERRCODE = 'P0001';
  END IF;
  EXECUTE definition;
END
$migration$;

COMMIT;
