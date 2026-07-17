-- R3-A data migration: recognized historical BuildRun kinds already use deterministic workflow IDs.
-- Unknown future kinds remain NULL and must be handled by their owning application deployment.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

UPDATE "site_build_run"
SET "temporal_workflow_id" = CASE
  WHEN kind = 'demo_v0' THEN 'site-demo-' || id::text
  WHEN kind = 'refurbish' THEN 'site-refurbish-' || id::text
  ELSE NULL
END
WHERE "temporal_workflow_id" IS NULL
  AND kind IN ('demo_v0', 'refurbish');

COMMIT;
