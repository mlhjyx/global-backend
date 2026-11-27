BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.discovery_v3_operation ADD COLUMN gateway_sweep_selected_at timestamptz(3);
CREATE INDEX discovery_v3_gateway_terminal_sweep_idx ON public.discovery_v3_operation
  (gateway_sweep_selected_at ASC NULLS FIRST, id)
  WHERE gateway_readback IS NOT NULL AND finished_at IS NOT NULL;

CREATE FUNCTION public.claim_discovery_v3_terminal_gateway_readbacks_v1(p_limit integer)
RETURNS TABLE(operation_id uuid, command jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_setting('role', true) IS DISTINCT FROM 'none'
     OR public.current_workspace_id() IS NOT NULL
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 32
  THEN RAISE EXCEPTION 'DISCOVERY_V3_GATEWAY_SWEEP_DENIED' USING ERRCODE = '42501'; END IF;

  -- Selection rotates even when a later worker step crashes or evidence needs human review.
  -- The probe table remains the authority for the number of physical GETs.
  RETURN QUERY
  WITH fair_page AS (
    SELECT op.id, op.gateway_sweep_selected_at
    FROM public.discovery_v3_operation op
    JOIN public.discovery_run run ON run.workspace_id=op.workspace_id AND run.id=op.run_id
    WHERE run.execution_contract_version=3 AND run.status IN ('DONE','PARTIAL','FAILED','CANCELLED')
      AND run.v3_worker_accepted_at IS NOT NULL AND run.completed_at IS NOT NULL
      AND op.kind='MODEL' AND op.status IN ('SUCCEEDED','FAILED','UNKNOWN') AND op.finished_at IS NOT NULL
      AND op.gateway_readback IS NOT NULL AND COALESCE(op.cost->>'basis','UNKNOWN') NOT IN ('PROVIDER_REPORTED','CONFIRMED_ZERO')
      AND (NOT EXISTS (
        SELECT 1 FROM public.discovery_v3_gateway_probe p
        WHERE p.workspace_id=op.workspace_id AND p.operation_id=op.id AND p.sequence=2
      ) OR EXISTS (
        SELECT 1 FROM public.discovery_v3_gateway_probe p
        WHERE p.workspace_id=op.workspace_id AND p.operation_id=op.id AND p.phase='gateway_log_observed'
          AND jsonb_typeof(p.evidence#>'{actualCharge,amountMicros}')='number'
      ))
    ORDER BY op.gateway_sweep_selected_at NULLS FIRST, op.id
    LIMIT p_limit
    FOR UPDATE OF op SKIP LOCKED
  ), claimed AS (
    UPDATE public.discovery_v3_operation op SET gateway_sweep_selected_at=statement_timestamp()
    FROM fair_page WHERE op.id=fair_page.id
    RETURNING op.id, op.workspace_id, op.run_id
  )
  SELECT chosen.id, jsonb_strip_nulls(jsonb_build_object(
    'executionContractVersion', run.execution_contract_version, 'workspaceId', run.workspace_id, 'runId', run.id,
    'planId', run.plan_id, 'icpId', run.icp_id, 'attemptId', run.v3_attempt_id, 'requestSha256', run.v3_request_sha256,
    'taskQueue', run.v3_task_queue, 'manufacturerNetworkRevision', run.v3_manufacturer_revision,
    'dispatchExpiresAt', to_char(run.v3_dispatch_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ))
  FROM claimed chosen JOIN fair_page ON fair_page.id=chosen.id
  JOIN public.discovery_run run ON run.workspace_id=chosen.workspace_id AND run.id=chosen.run_id
  ORDER BY fair_page.gateway_sweep_selected_at NULLS FIRST, chosen.id;
END
$$;

REVOKE ALL ON FUNCTION public.claim_discovery_v3_terminal_gateway_readbacks_v1(integer) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.claim_discovery_v3_terminal_gateway_readbacks_v1(integer) TO app_user;

COMMIT;
