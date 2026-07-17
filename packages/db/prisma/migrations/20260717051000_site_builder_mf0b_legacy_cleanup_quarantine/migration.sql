-- MF0-B forward rollout: explicitly quarantine pre-ledger tombstones, then validate lifecycle.
-- 050000 is already applied in the Ubuntu development database and remains immutable.
BEGIN;

ALTER TABLE "asset"
  ADD COLUMN "cleanup_legacy_unbound" BOOLEAN NOT NULL DEFAULT false;

-- NOT VALID skips the historical table scan only when it is created; PostgreSQL still enforces
-- the old check on every later UPDATE. Drop it before marking the rows it was designed to admit.
-- This migration is transactional, so a later failure restores the old constraint and data.
ALTER TABLE "asset" DROP CONSTRAINT "asset_cleanup_lifecycle_check";

UPDATE "asset"
SET "cleanup_legacy_unbound" = true
WHERE "deleted_at" IS NOT NULL
  AND "cleanup_event_id" IS NULL;

ALTER TABLE "asset"
  ADD CONSTRAINT "asset_cleanup_lifecycle_check"
  CHECK (
    (
      "deleted_at" IS NULL
      AND "cleanup_event_id" IS NULL
      AND "cleanup_completed_at" IS NULL
      AND "cleanup_legacy_unbound" = false
    )
    OR
    (
      "deleted_at" IS NOT NULL
      AND "cleanup_event_id" IS NOT NULL
      AND "cleanup_legacy_unbound" = false
    )
    OR
    (
      "deleted_at" IS NOT NULL
      AND "cleanup_event_id" IS NULL
      AND "cleanup_completed_at" IS NULL
      AND "cleanup_legacy_unbound" = true
    )
  );

CREATE OR REPLACE FUNCTION "asset_cleanup_legacy_marker_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.cleanup_legacy_unbound = true
     AND (TG_OP = 'INSERT' OR OLD.cleanup_legacy_unbound = false) THEN
    RAISE EXCEPTION 'cleanup_legacy_unbound is reserved for migration-quarantined tombstones'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_cleanup_legacy_marker_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "asset_cleanup_legacy_marker_guard_trigger"
BEFORE INSERT OR UPDATE OF "cleanup_legacy_unbound" ON "asset"
FOR EACH ROW EXECUTE FUNCTION "asset_cleanup_legacy_marker_guard"();

COMMIT;
