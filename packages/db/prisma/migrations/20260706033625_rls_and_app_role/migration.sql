-- Multi-tenant Row-Level Security (ADR-001).
--
-- Model: the app runtime connects as a NON-superuser role (app_user) and sets
-- app.current_workspace_id per transaction. Superusers/table owners bypass RLS,
-- which is why the app must not connect as the owner. FORCE keeps even the
-- owner subject to policies as defense in depth.

-- 1) Tenant helper: reads the transaction-local workspace id (NULL if unset).
CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
$$;

-- 2) Non-superuser application role (idempotent — roles are cluster-global).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pw';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
-- Future tables/sequences created by the owner are granted automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE global IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE global IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- 3) RLS on workspace-scoped tables. Every new domain table follows this exact
--    pattern: enable + force + a USING/WITH CHECK policy on current_workspace_id().
ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_event FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_event_tenant_isolation ON outbox_event
  USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

-- The workspace row itself is visible when it is the active workspace.
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_tenant_isolation ON workspace
  USING (id = current_workspace_id())
  WITH CHECK (id = current_workspace_id());