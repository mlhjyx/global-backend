-- R3-A: database backstops for BuildRun tenant provenance, legal states and site single-flight.
--
-- This migration is intentionally fail-closed. It never guesses ownership, rewrites status or
-- chooses a duplicate active run to cancel. Operators must reconcile any reported row explicitly.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "site_build_run" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "site_build_run" AS r
    LEFT JOIN "site" AS s ON s."id" = r."site_id"
    WHERE s."id" IS NULL OR s."workspace_id" <> r."workspace_id"
  ) THEN
    RAISE EXCEPTION 'R3-A blocked: site_build_run contains missing or cross-workspace Site provenance'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "site_build_run"
    WHERE status NOT IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'R3-A blocked: site_build_run contains an illegal status'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT site_id
    FROM "site_build_run"
    WHERE status IN ('queued', 'running')
    GROUP BY site_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'R3-A blocked: a Site owns more than one active BuildRun'
      USING ERRCODE = '23505';
  END IF;
END $$;

ALTER TABLE "site_build_run"
  ADD COLUMN "temporal_workflow_id" TEXT;

ALTER TABLE "site_build_run"
  DROP CONSTRAINT "site_build_run_site_id_fkey";

ALTER TABLE "site_build_run"
  ADD CONSTRAINT "site_build_run_site_id_workspace_id_fkey"
  FOREIGN KEY ("site_id", "workspace_id")
  REFERENCES "site"("id", "workspace_id")
  ON DELETE CASCADE
  ON UPDATE NO ACTION;

ALTER TABLE "site_build_run"
  ADD CONSTRAINT "site_build_run_status_check"
  CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
  NOT VALID;

ALTER TABLE "site_build_run"
  VALIDATE CONSTRAINT "site_build_run_status_check";

CREATE UNIQUE INDEX "site_build_run_one_active_per_site_idx"
  ON "site_build_run"("site_id")
  WHERE "status" IN ('queued', 'running');

COMMIT;
