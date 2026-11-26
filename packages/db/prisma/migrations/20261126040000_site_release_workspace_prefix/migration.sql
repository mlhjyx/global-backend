-- Scope newly created site_release artifact prefixes under ws/<workspace_id>/
-- while preserving legacy sites/<site_id>/releases/<release_id> rows for
-- existing releases and previews.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

LOCK TABLE "site_release" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "site_release"
  DROP CONSTRAINT "site_release_artifact_prefix_check";

ALTER TABLE "site_release"
  ADD CONSTRAINT "site_release_artifact_prefix_check"
  CHECK (
    "artifact_prefix" IN (
      'ws/' || "workspace_id"::text || '/sites/' || "site_id"::text || '/releases/' || "id"::text,
      'sites/' || "site_id"::text || '/releases/' || "id"::text
    )
  );

COMMIT;
