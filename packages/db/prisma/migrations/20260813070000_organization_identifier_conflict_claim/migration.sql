-- Bind every pending identifier claim to the deterministic conflict that owns
-- it. The table was empty when Identity v2 first shipped; fail closed if an
-- intermediate build nevertheless wrote ownerless pending claims.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

LOCK TABLE "organization_identifier", "organization_identity_conflict"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "organization_identifier"
  ADD COLUMN "conflict_id" UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "organization_identifier"
    WHERE "status" = 'PENDING_CONFLICT'
  ) THEN
    RAISE EXCEPTION 'organization_identifier contains a pending claim without a deterministic conflict owner';
  END IF;
END;
$$;

ALTER TABLE "organization_identifier"
  ADD CONSTRAINT "organization_identifier_pending_conflict_owner_check"
  CHECK ("status" <> 'PENDING_CONFLICT' OR "conflict_id" IS NOT NULL);

CREATE UNIQUE INDEX "organization_identifier_conflict_claim_key"
  ON "organization_identifier"("workspace_id", "conflict_id", "scheme", "jurisdiction", "normalized_value");

ALTER TABLE "organization_identifier"
  ADD CONSTRAINT "organization_identifier_conflict_scope_fkey"
  FOREIGN KEY ("workspace_id", "conflict_id")
  REFERENCES "organization_identity_conflict"("workspace_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMIT;
