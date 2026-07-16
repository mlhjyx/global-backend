-- R2-A1: make Asset commit claimable/retryable and make deletion a tombstone.
-- The later R2-A4 consumer will redrive parked cleanup commands; MF-0 adds the
-- reference scanner required before canonical objects may actually be deleted.

ALTER TABLE "asset"
  ADD COLUMN "processing_attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "lease_until" TIMESTAMP(3),
  ADD COLUMN "retry_at" TIMESTAMP(3),
  ADD COLUMN "deleted_at" TIMESTAMP(3);

-- A tombstoned row keeps its historical canonical key. Only active rows must
-- remain unique, so a later upload can safely reclaim the same content key.
DROP INDEX "asset_object_key_key";
CREATE INDEX "asset_object_key_lookup_idx" ON "asset"("object_key");
CREATE UNIQUE INDEX "asset_object_key_active_key"
  ON "asset"("object_key")
  WHERE "deleted_at" IS NULL;

CREATE INDEX "asset_workspace_id_processing_status_retry_at_idx"
  ON "asset"("workspace_id", "processing_status", "retry_at");

ALTER TABLE "asset"
  ADD CONSTRAINT "asset_processing_status_check"
  CHECK (
    "processing_status" IN (
      'pending_upload',
      'committing',
      'queued',
      'processing',
      'ready',
      'failed',
      'failed_retryable',
      'rejected',
      'duplicate',
      'deleted'
    )
  ) NOT VALID;

ALTER TABLE "asset" VALIDATE CONSTRAINT "asset_processing_status_check";

ALTER TABLE "asset"
  ADD CONSTRAINT "asset_commit_lease_shape_check"
  CHECK (
    ("processing_status" = 'committing' AND "lease_token" IS NOT NULL AND "lease_until" IS NOT NULL)
    OR
    ("processing_status" <> 'committing' AND "lease_token" IS NULL AND "lease_until" IS NULL)
  ) NOT VALID;

ALTER TABLE "asset" VALIDATE CONSTRAINT "asset_commit_lease_shape_check";

ALTER TABLE "asset"
  ADD CONSTRAINT "asset_deleted_tombstone_check"
  CHECK (
    ("processing_status" = 'deleted' AND "deleted_at" IS NOT NULL)
    OR
    ("processing_status" <> 'deleted' AND "deleted_at" IS NULL)
  ) NOT VALID;

ALTER TABLE "asset" VALIDATE CONSTRAINT "asset_deleted_tombstone_check";
