-- Additive, read-only locator observation. This is not consumption authorization
-- or proof of a successful fence. No retained data is changed by this migration.
-- Rollback: stop lookup consumers; retain the function until a forward migration
-- can remove it safely. Never undo an existing revocation to roll back a reader.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.lookup_platform_authority_target_v1(
  p_target_issuer TEXT, p_target_jti UUID, p_schedule_id TEXT, p_workflow_run_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_execution_budget_platform_writer_principal();
  -- Match the established signed-revocation SQL boundary, including UUID
  -- version/variant and the closed schedule set. Invalid is not NOT_FOUND.
  IF p_target_issuer IS NULL OR char_length(p_target_issuer) NOT BETWEEN 1 AND 2048
    OR p_target_issuer ~ '[[:space:][:cntrl:]]'
    OR p_target_jti IS NULL
    OR p_target_jti::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_schedule_id IS NULL
    OR p_schedule_id NOT IN ('acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh')
    OR p_workflow_run_id IS NULL
    OR p_workflow_run_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'PLATFORM_AUTHORITY_TARGET_LOOKUP_INVALID' USING ERRCODE = 'P0001';
  END IF;

  -- Fully qualify the relation: pg_temp must never substitute a locator table.
  -- The unique issuer/JTI index bounds this read. Deliberately do not filter
  -- expiry/revocation: both remain valid locators for the existing fence logic.
  RETURN EXISTS (
    SELECT 1 FROM public.execution_budget_authority AS a
    WHERE a.scope_key = 'platform' AND a.authority_kind = 'PLATFORM_GRANT'
      AND a.issuer = p_target_issuer AND a.jti = p_target_jti
      AND a.schedule_id = p_schedule_id AND a.workflow_run_id = p_workflow_run_id
  );
END;
$$;

-- Explicit role revokes also override pre-existing owner function defaults.
REVOKE ALL ON FUNCTION public.lookup_platform_authority_target_v1(TEXT,UUID,TEXT,TEXT)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,
    execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION public.lookup_platform_authority_target_v1(TEXT,UUID,TEXT,TEXT)
  TO execution_budget_platform_writer;

COMMIT;
