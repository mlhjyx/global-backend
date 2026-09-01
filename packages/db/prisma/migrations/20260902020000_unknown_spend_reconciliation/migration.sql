-- Physical model/tool execution with an ambiguous ACK is an UNKNOWN fact, not
-- a known failure. This additive function preserves the existing known-result
-- settlement function while atomically consuming the full reservation for an
-- UNKNOWN operation. The application disables further paid calls in the same
-- workspace transaction immediately after this function returns SETTLED.
CREATE FUNCTION settle_unknown_site_build_spend(
  p_workspace_id UUID,
  p_build_run_id UUID,
  p_operation_key VARCHAR(64),
  p_fence_token UUID,
  p_budget_charge_microusd BIGINT,
  p_input_tokens INTEGER,
  p_output_tokens INTEGER,
  p_call_count INTEGER,
  p_meta JSONB,
  p_error_code TEXT,
  p_disable_reason TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_budget site_build_budget%ROWTYPE;
  v_spend site_build_spend%ROWTYPE;
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  IF p_budget_charge_microusd < 0
    OR p_call_count IS NULL OR p_call_count < 1
    OR (p_input_tokens IS NOT NULL AND p_input_tokens < 0)
    OR (p_output_tokens IS NOT NULL AND p_output_tokens < 0)
    OR p_meta IS NULL OR jsonb_typeof(p_meta) <> 'object'
    OR p_disable_reason IS NULL
    OR char_length(btrim(p_disable_reason)) < 1
    OR char_length(p_disable_reason) > 80
  THEN
    RAISE EXCEPTION 'invalid unknown paid-call settlement';
  END IF;

  SELECT * INTO v_budget
  FROM site_build_budget
  WHERE build_run_id = p_build_run_id
    AND workspace_id = p_workspace_id
  FOR UPDATE;

  SELECT * INTO v_spend
  FROM site_build_spend
  WHERE workspace_id = p_workspace_id
    AND build_run_id = p_build_run_id
    AND operation_key = p_operation_key
  FOR UPDATE;

  IF v_budget.build_run_id IS NULL OR v_spend.id IS NULL THEN
    RETURN 'MISSING';
  END IF;
  IF v_spend.status <> 'RESERVED' THEN
    RETURN 'REPLAY';
  END IF;
  IF v_spend.fence_token IS DISTINCT FROM p_fence_token THEN
    RETURN 'STALE_FENCE';
  END IF;
  IF p_budget_charge_microusd <> v_spend.reservation_microusd THEN
    RAISE EXCEPTION 'unknown settlement must consume the full reservation';
  END IF;

  UPDATE site_build_spend
  SET status = 'UNKNOWN',
      budget_charge_microusd = v_spend.reservation_microusd,
      reported_cost_microusd = NULL,
      calculated_cost_microusd = NULL,
      estimated_cost_microusd = NULL,
      cost_basis = 'unknown',
      input_tokens = p_input_tokens,
      output_tokens = p_output_tokens,
      call_count = p_call_count,
      result_json = NULL,
      meta = p_meta,
      error_code = p_error_code,
      settled_at = clock_timestamp()
  WHERE id = v_spend.id;

  UPDATE site_build_budget
  SET reserved_microusd = GREATEST(0, reserved_microusd - v_spend.reservation_microusd),
      charged_microusd = charged_microusd + v_spend.reservation_microusd,
      paid_calls_enabled = false,
      disabled_reason = p_disable_reason,
      updated_at = clock_timestamp()
  WHERE build_run_id = p_build_run_id
    AND workspace_id = p_workspace_id;

  RETURN 'SETTLED';
END
$$;

REVOKE ALL ON FUNCTION settle_unknown_site_build_spend(
  UUID, UUID, VARCHAR, UUID, BIGINT, INTEGER, INTEGER, INTEGER, JSONB, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_unknown_site_build_spend(
  UUID, UUID, VARCHAR, UUID, BIGINT, INTEGER, INTEGER, INTEGER, JSONB, TEXT, TEXT
) TO app_user;

-- Correct only the historically misclassified fact. Amounts, request IDs,
-- provider observations, error codes and timestamps remain unchanged.
WITH affected AS MATERIALIZED (
  SELECT
    s.id,
    s.build_run_id,
    NOT EXISTS (
      SELECT 1
      FROM site_build_spend_reconciliation r
      WHERE r.spend_id = s.id
        AND r.status IN ('RESOLVED', 'CONFLICT', 'EXPIRED')
    ) AS remains_pending
  FROM site_build_spend s
  WHERE s.status = 'FAILED'
    AND s.cost_basis = 'unknown'
), updated_spends AS (
  UPDATE site_build_spend s
  SET status = 'UNKNOWN'
  FROM affected a
  WHERE s.id = a.id
  RETURNING s.id
), disabled_budgets AS (
  UPDATE site_build_budget budget
  SET paid_calls_enabled = false,
      disabled_reason = COALESCE(
        NULLIF(budget.disabled_reason, ''),
        'UNKNOWN_SETTLEMENT_BACKFILL'
      ),
      updated_at = clock_timestamp()
  WHERE budget.build_run_id IN (SELECT DISTINCT build_run_id FROM affected)
  RETURNING budget.build_run_id, budget.disabled_reason
), per_run AS (
  SELECT
    build_run_id,
    COUNT(*)::integer AS corrected_operations,
    COUNT(*) FILTER (WHERE remains_pending)::integer AS added_pending_operations
  FROM affected
  GROUP BY build_run_id
)
UPDATE site_build_run run
SET cost_summary = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          run.cost_summary,
          '{operations,failed}',
          to_jsonb(GREATEST(
            0,
            COALESCE((run.cost_summary #>> '{operations,failed}')::integer, 0)
              - per_run.corrected_operations
          )),
          true
        ),
        '{operations,unknown}',
        to_jsonb(
          COALESCE((run.cost_summary #>> '{operations,unknown}')::integer, 0)
            + per_run.corrected_operations
        ),
        true
      ),
      '{reconciliation,pendingOperations}',
      to_jsonb(
        COALESCE((run.cost_summary #>> '{reconciliation,pendingOperations}')::integer, 0)
          + per_run.added_pending_operations
      ),
      true
    ),
    '{budget,paidCallsEnabled}',
    'false'::jsonb,
    true
  ),
  '{budget,disabledReason}',
  to_jsonb(disabled_budgets.disabled_reason),
  true
)
FROM per_run
JOIN disabled_budgets USING (build_run_id)
WHERE run.id = per_run.build_run_id
  AND jsonb_typeof(run.cost_summary) = 'object';
