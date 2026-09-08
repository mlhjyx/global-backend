-- Read-only capability probe for the durable platform egress fence.
-- The probe is SECURITY DEFINER because the fence tables are FORCE RLS and
-- runtime principals must not receive direct table access.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION inspect_platform_egress_fence_v1(
  p_schedule_id TEXT
)
RETURNS TABLE(
  schedule_id TEXT,
  state TEXT,
  generation BIGINT,
  can_fence BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_schedule_id IS NULL
    OR p_schedule_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$'
  THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_FENCE_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    fence.schedule_id::TEXT,
    fence.state::TEXT,
    fence.generation,
    has_function_privilege(
      session_user,
      'public.fence_platform_schedule_v1(text,text)'::regprocedure,
      'EXECUTE'
    )
  FROM public.platform_egress_schedule_fence AS fence
  WHERE fence.schedule_id = p_schedule_id;
END
$$;

REVOKE ALL ON FUNCTION inspect_platform_egress_fence_v1(TEXT)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,
       execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION inspect_platform_egress_fence_v1(TEXT)
  TO execution_budget_platform_writer;

COMMIT;
