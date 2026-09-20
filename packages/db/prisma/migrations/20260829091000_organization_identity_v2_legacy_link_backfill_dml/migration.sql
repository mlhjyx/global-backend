BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

LOCK TABLE "canonical_company" IN SHARE MODE;
LOCK TABLE "canonical_contact" IN SHARE MODE;
LOCK TABLE "raw_source_record" IN SHARE MODE;
LOCK TABLE "identity_link" IN SHARE MODE;

DO $legacy_identity_link_backfill$
DECLARE
  expected_row_count BIGINT;
  updated_row_count BIGINT;
  actual_row_count BIGINT;
BEGIN
  SELECT count(*)
  INTO expected_row_count
  FROM "identity_link";

  IF EXISTS (
    SELECT 1
    FROM "identity_link"
    WHERE canonical_type NOT IN ('company', 'contact')
  ) THEN
    RAISE EXCEPTION 'unsupported canonical_type in legacy identity_link';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "identity_link" AS link
    WHERE link."canonical_type" = 'company'
      AND NOT EXISTS (
        SELECT 1
        FROM "canonical_company" AS company
        WHERE company."id" = link."canonical_id"
          AND company."workspace_id" = link."workspace_id"
      )
  ) THEN
    RAISE EXCEPTION 'missing or cross-workspace company target in legacy identity_link';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "identity_link" AS link
    WHERE link."canonical_type" = 'contact'
      AND NOT EXISTS (
        SELECT 1
        FROM "canonical_contact" AS contact
        WHERE contact."id" = link."canonical_id"
          AND contact."workspace_id" = link."workspace_id"
      )
  ) THEN
    RAISE EXCEPTION 'missing or cross-workspace contact target in legacy identity_link';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "identity_link" AS link
    WHERE NOT EXISTS (
      SELECT 1
      FROM "raw_source_record" AS raw
      WHERE raw."id" = link."raw_record_id"
        AND raw."workspace_id" = link."workspace_id"
    )
  ) THEN
    RAISE EXCEPTION 'missing or cross-workspace raw target in legacy identity_link';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "identity_link"
    GROUP BY "workspace_id",
      "canonical_type",
      "canonical_id",
      "raw_record_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate canonical/raw binding in legacy identity_link';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "identity_link"
    WHERE "status" IS NOT NULL
      OR "resolver_version" IS NOT NULL
      OR "input_hash" IS NOT NULL
      OR "conflict_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'unexpected partial lifecycle state in legacy identity_link';
  END IF;

UPDATE "identity_link"
  SET "status" = 'ACTIVE',
      "resolver_version" = 'identity-v1',
      "input_hash" = 'legacy',
      "conflict_id" = NULL;

  GET DIAGNOSTICS updated_row_count = ROW_COUNT;

  IF updated_row_count <> expected_row_count THEN
    RAISE EXCEPTION 'updated row count changed during legacy identity_link backfill';
  END IF;

  SELECT count(*)
  INTO actual_row_count
  FROM "identity_link";

  IF actual_row_count <> expected_row_count THEN
    RAISE EXCEPTION 'post-backfill row count changed during legacy identity_link backfill';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "identity_link"
    WHERE "status" IS DISTINCT FROM 'ACTIVE'
      OR "resolver_version" IS DISTINCT FROM 'identity-v1'
      OR "input_hash" IS DISTINCT FROM 'legacy'
      OR "conflict_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'post-backfill lifecycle validation failed for legacy identity_link';
  END IF;
END
$legacy_identity_link_backfill$;

COMMIT;
