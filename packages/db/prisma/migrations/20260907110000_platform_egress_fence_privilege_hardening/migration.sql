-- Harden the already-merged 4D fence kill-switch function. The predecessor
-- migration created a SECURITY DEFINER function with PostgreSQL's default
-- PUBLIC EXECUTE privilege and no caller-principal assertion.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION fence_platform_schedule_v1(
  p_schedule_id TEXT,
  p_reason TEXT
)
RETURNS TABLE(generation BIGINT, blocked_attempts BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  next_generation BIGINT;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_schedule_id IS NULL
    OR p_schedule_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$'
    OR p_reason IS NULL
    OR char_length(p_reason) NOT BETWEEN 1 AND 80
  THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_FENCE_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE "platform_egress_schedule_fence"
    SET generation = platform_egress_schedule_fence.generation + 1,
        state = 'DISABLED',
        updated_at = clock_timestamp()
    WHERE schedule_id = p_schedule_id
    RETURNING platform_egress_schedule_fence.generation INTO next_generation;
  IF next_generation IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_SCHEDULE_UNKNOWN'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE "platform_egress_attempt"
    SET state = 'BLOCKED',
        outcome_meta = jsonb_build_object('reason', p_reason)
    WHERE platform_egress_attempt.schedule_id = p_schedule_id
      AND platform_egress_attempt.generation < next_generation
      AND platform_egress_attempt.state = 'AUTHORIZED';
  GET DIAGNOSTICS blocked_attempts = ROW_COUNT;
  generation := next_generation;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION fence_platform_schedule_v1(TEXT, TEXT)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,
       execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION fence_platform_schedule_v1(TEXT, TEXT)
  TO execution_budget_platform_writer;

COMMIT;
