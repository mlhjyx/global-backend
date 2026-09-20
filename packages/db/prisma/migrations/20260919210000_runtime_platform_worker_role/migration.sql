-- Commit enum addition before the following migration uses the new value.
BEGIN;
ALTER TYPE public.runtime_process_role ADD VALUE IF NOT EXISTS 'PLATFORM_WORKER';
DO $$
DECLARE role_row pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO role_row FROM pg_catalog.pg_roles WHERE rolname='runtime_platform_worker';
  IF role_row.oid IS NULL THEN
    CREATE ROLE runtime_platform_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF role_row.rolcanlogin OR role_row.rolsuper OR role_row.rolbypassrls
    OR role_row.rolcreatedb OR role_row.rolcreaterole OR role_row.rolreplication
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=role_row.oid)
  THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED';
  END IF;
END $$;
COMMIT;
