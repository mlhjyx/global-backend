-- ADR-003 (F12): Grant narrow platform_shared privileges to runtime_customer_worker_ops
-- so customer discovery worker (which is forbidden from holding execution_budget_platform_writer)
-- can persist sanitized green facts and 30-day HMAC cooldown touches under physical DB triggers.
-- app_user remains strictly SELECT-only on platform_shared; pg_default_acl is untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_customer_worker_ops') THEN
    GRANT USAGE ON SCHEMA platform_shared TO runtime_customer_worker_ops;
    GRANT SELECT, INSERT, UPDATE ON TABLE platform_shared.company_fact TO runtime_customer_worker_ops;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE platform_shared.domain_cooldown_touch TO runtime_customer_worker_ops;
  END IF;
END $$;

COMMIT;
