-- source_policy (the per-domain allow/block list for Raw ingestion and the ToolBroker) and
-- data_provider (whose status turns a data provider on or off) are platform governance tables
-- without RLS. Their migrations granted app_user SELECT only, but the default privileges set in
-- 20260706033625_rls_and_app_role already gave app_user SELECT, INSERT, UPDATE and DELETE on
-- every table the owner creates, so a session running SQL as app_user could approve any domain
-- or enable a DISABLED provider. Only the owner connection writes these tables (the
-- provider-registry and sanctions seeds, operator scripts), so app_user keeps SELECT only.
-- The runtime roles hold no privilege on either table; they are revoked too so that every role
-- in that family stays read-only wherever an environment drifted.
-- Privileges only: no data, schema or default privileges change.
-- Rollback: none needed. Granting the writes back to app_user would reopen the gap.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.source_policy, public.data_provider
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_platform_worker,
    runtime_outbox_relay;
GRANT SELECT ON TABLE public.source_policy, public.data_provider TO app_user;

-- app_user, the runtime roles and every role that is a member of one of them (the runtime
-- logins, the site-build provider-wire login) must be left with no write privilege, whether
-- granted directly, through PUBLIC or through membership. Superusers and the table owner are
-- outside that family by definition.
DO $$
DECLARE
  remaining TEXT;
BEGIN
  WITH RECURSIVE family(oid) AS (
    SELECT r.oid FROM pg_catalog.pg_roles AS r
    WHERE r.rolname IN ('app_user', 'runtime_api', 'runtime_worker',
      'runtime_platform_worker', 'runtime_outbox_relay')
    UNION
    SELECT m.member FROM pg_catalog.pg_auth_members AS m
    JOIN family AS f ON f.oid = m.roleid
  )
  SELECT string_agg(format('%s %s %s', r.rolname, c.relname, p.privilege), ', '
      ORDER BY r.rolname, c.relname, p.privilege)
    INTO remaining
  FROM family AS f
  JOIN pg_catalog.pg_roles AS r ON r.oid = f.oid
  CROSS JOIN pg_catalog.pg_class AS c
  CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
    AS p(privilege)
  WHERE c.oid IN ('public.source_policy'::regclass, 'public.data_provider'::regclass)
    AND NOT r.rolsuper
    AND r.oid <> c.relowner
    AND pg_catalog.has_table_privilege(r.oid, c.oid, p.privilege);
  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION 'GOVERNANCE_TABLE_WRITE_PRIVILEGE_REMAINS: %', remaining;
  END IF;
  IF NOT (pg_catalog.has_table_privilege('app_user', 'public.source_policy', 'SELECT')
    AND pg_catalog.has_table_privilege('app_user', 'public.data_provider', 'SELECT'))
  THEN
    RAISE EXCEPTION 'GOVERNANCE_TABLE_APP_USER_SELECT_MISSING';
  END IF;
END $$;

COMMIT;
