-- R3-A review hardening: tenant provenance must never move implicitly with a parent update.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "site_build_run" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "site_build_run"
  DROP CONSTRAINT "site_build_run_site_id_workspace_id_fkey";

ALTER TABLE "site_build_run"
  ADD CONSTRAINT "site_build_run_site_id_workspace_id_fkey"
  FOREIGN KEY ("site_id", "workspace_id")
  REFERENCES "site"("id", "workspace_id")
  ON DELETE CASCADE
  ON UPDATE NO ACTION;

COMMIT;
