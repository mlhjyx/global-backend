-- MF0-B: durable canonical cleanup ownership + database-enforced Variant/delete serialization.
-- Additive and forward-only. Object deletion remains outside database transactions.
ALTER TABLE "asset"
  ADD COLUMN "cleanup_event_id" UUID,
  ADD COLUMN "cleanup_completed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "asset_cleanup_event_id_key"
  ON "asset"("cleanup_event_id")
  WHERE "cleanup_event_id" IS NOT NULL;

ALTER TABLE "asset"
  ADD CONSTRAINT "asset_cleanup_lifecycle_check"
  CHECK (
    ("deleted_at" IS NULL AND "cleanup_event_id" IS NULL AND "cleanup_completed_at" IS NULL)
    OR
    ("deleted_at" IS NOT NULL AND "cleanup_event_id" IS NOT NULL)
  ) NOT VALID;

-- NOT VALID is intentional for upgrade safety: historical tombstones predate cleanup_event_id.
-- MF0-B reconciliation binds each eligible legacy tombstone to a new strict command before a
-- later migration validates the constraint. PostgreSQL still enforces this check for new writes.

-- A Variant writer and Asset DELETE must serialize on the same parent row. The trigger is a
-- database backstop for future writers that forget the application helper: delete-first makes
-- the insert/finalize fail; variant-first makes DELETE wait and observe the processing row.
CREATE OR REPLACE FUNCTION "asset_variant_require_live_parent"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
  FROM public.asset AS a
  WHERE a.id = NEW.asset_id
    AND a.workspace_id = NEW.workspace_id
    AND a.site_id = NEW.site_id
    AND a.deleted_at IS NULL
    AND a.cleanup_event_id IS NULL
    AND a.processing_status = 'ready'
    AND a.content_hash IS NOT NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AssetVariant parent Asset must be live, ready and checksummed'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_variant_live_parent_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "asset_variant_require_live_parent_trigger"
BEFORE INSERT OR UPDATE ON "asset_variant"
FOR EACH ROW EXECUTE FUNCTION "asset_variant_require_live_parent"();
