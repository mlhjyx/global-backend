-- Narrow read-only SECURITY DEFINER RPC for workspace usage-summary aggregation
-- over public.generic_operation_artifact while preserving app_user's zero
-- direct-table-privilege posture on that table.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.summarize_workspace_generic_operation_artifacts_v1()
RETURNS TABLE(
  total_count BIGINT,
  total_bytes BIGINT,
  personal_count BIGINT,
  personal_bytes BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_wid UUID;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_user IS NOT DISTINCT FROM session_user
     OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'WORKSPACE_USAGE_SUMMARY_DENIED'
      USING ERRCODE = '42501';
  END IF;

  v_wid := current_workspace_id();
  IF v_wid IS NULL THEN
    RAISE EXCEPTION 'WORKSPACE_USAGE_SUMMARY_WORKSPACE_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT
      count(*)::BIGINT AS total_count,
      coalesce(sum(a."size_bytes"), 0)::BIGINT AS total_bytes,
      count(*) FILTER (WHERE a."privacy_class" = 'PERSONAL_DATA')::BIGINT AS personal_count,
      coalesce(
        sum(a."size_bytes") FILTER (WHERE a."privacy_class" = 'PERSONAL_DATA'),
        0
      )::BIGINT AS personal_bytes
    FROM public."generic_operation_artifact" a
    WHERE a."workspace_id" = v_wid
      AND a."scope_key" = v_wid::text;
END;
$$;

REVOKE ALL ON FUNCTION public.summarize_workspace_generic_operation_artifacts_v1()
  FROM PUBLIC,
       app_user,
       execution_budget_platform_writer,
       runtime_api,
       runtime_worker,
       runtime_outbox_relay,
       runtime_platform_worker,
       runtime_outbox_relay_worker,
       runtime_memory_outbox_reader,
       runtime_customer_worker_ops;

GRANT EXECUTE ON FUNCTION public.summarize_workspace_generic_operation_artifacts_v1()
  TO app_user;

COMMIT;
