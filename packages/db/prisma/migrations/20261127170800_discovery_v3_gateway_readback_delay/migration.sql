BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  sweep text := pg_get_functiondef('public.claim_discovery_v3_terminal_gateway_readbacks_v1(integer)'::regprocedure);
  before_delay text := $old$AND (NOT EXISTS (
        SELECT 1 FROM public.discovery_v3_gateway_probe p
        WHERE p.workspace_id=op.workspace_id AND p.operation_id=op.id AND p.sequence=2
      ) OR EXISTS ($old$;
  after_delay text := $new$AND ((run.completed_at <= statement_timestamp() - interval '1 minute' AND NOT EXISTS (
        SELECT 1 FROM public.discovery_v3_gateway_probe p
        WHERE p.workspace_id=op.workspace_id AND p.operation_id=op.id AND p.sequence=2
      )) OR EXISTS ($new$;
BEGIN
  IF length(sweep) - length(replace(sweep, before_delay, '')) <> length(before_delay) THEN
    RAISE EXCEPTION 'DISCOVERY_V3_GATEWAY_SWEEP_DELAY_PATCH_TARGET_MISMATCH';
  END IF;
  EXECUTE replace(sweep, before_delay, after_delay);
END
$migration$;

COMMIT;
