-- P4 (platform.channel_crawl) first phase: extend the purpose enum only.
-- PostgreSQL cannot use a value added in the same transaction, so every shape,
-- function and grant change lands in 20261105001000 (same split as
-- outreach.draft, 20261028182000 -> 20261028183000). Forward-only.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TYPE "execution_budget_purpose"
  ADD VALUE IF NOT EXISTS 'platform.channel_crawl' AFTER 'platform.sanctions';

COMMIT;
