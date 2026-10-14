-- Understanding failure write-back (2026-10-13). Since 2026-08-24 the seller-onboarding
-- understanding workflow has failed at its first crawl: the G3 per-call subject gate (#565) held
-- every crawl4ai.fetch that named no artifact subject, and the workflow left company_profile at
-- ENRICHING with nothing recorded. Two nullable columns let the workflow return the row to DRAFT
-- and keep what stopped it: the stage and the failure type as `stage:errorType`, one closed token
-- each, never a message or any crawled content (the CHECK admits only that shape, and both columns
-- are set or cleared together). A new ENRICHING attempt clears both.
--
-- Additive, no backfill: rows already stuck at ENRICHING are not touched (no run is live for them;
-- they can be re-created once the seller-subject decision lands). app_user already holds UPDATE on
-- company_profile (20261010090000), and the API maps rows through CompanyDto, so the contract is
-- unchanged. Rollback: a later migration dropping the constraint and the two columns.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "company_profile"
  ADD COLUMN "understanding_failed_at" TIMESTAMPTZ(3),
  ADD COLUMN "understanding_last_error" VARCHAR(120),
  ADD CONSTRAINT "company_profile_understanding_failure_check"
    CHECK (
      ("understanding_failed_at" IS NULL) = ("understanding_last_error" IS NULL)
      AND (
        "understanding_last_error" IS NULL
        OR "understanding_last_error" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}:[A-Za-z][A-Za-z0-9_]{0,63}$'
      )
    );

COMMIT;
