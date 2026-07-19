-- R4-B follow-up: a provider can report a cost above the amount admitted by
-- reserve. Preserve that measurement as cost truth, but fail the operation
-- closed and charge at most its serialized reservation so the database ledger
-- cannot cross the BuildRun hard cap.

ALTER TABLE "site_build_budget"
  ADD CONSTRAINT "site_build_budget_hard_cap_check"
  CHECK ("charged_microusd" + "reserved_microusd" <= "cap_microusd")
  NOT VALID;

CREATE OR REPLACE FUNCTION settle_site_build_spend(
  p_workspace_id UUID,
  p_build_run_id UUID,
  p_operation_key VARCHAR(64),
  p_fence_token UUID,
  p_status TEXT,
  p_budget_charge_microusd BIGINT,
  p_cost_basis TEXT,
  p_reported_cost_microusd BIGINT,
  p_calculated_cost_microusd BIGINT,
  p_estimated_cost_microusd BIGINT,
  p_input_tokens INTEGER,
  p_output_tokens INTEGER,
  p_call_count INTEGER,
  p_result_json JSONB,
  p_meta JSONB,
  p_error_code TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_budget "site_build_budget"%ROWTYPE;
  v_spend "site_build_spend"%ROWTYPE;
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  IF p_status NOT IN ('SUCCEEDED', 'FAILED', 'RELEASED') OR p_budget_charge_microusd < 0 THEN
    RAISE EXCEPTION 'invalid paid-call settlement';
  END IF;

  SELECT * INTO v_budget
  FROM "site_build_budget"
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  SELECT * INTO v_spend
  FROM "site_build_spend"
  WHERE "build_run_id" = p_build_run_id
    AND "operation_key" = p_operation_key
  FOR UPDATE;

  IF v_budget."build_run_id" IS NULL OR v_spend."id" IS NULL THEN
    RETURN 'MISSING';
  END IF;
  IF v_spend."status" <> 'RESERVED' THEN
    RETURN 'REPLAY';
  END IF;
  IF v_spend."fence_token" IS DISTINCT FROM p_fence_token THEN
    RETURN 'STALE_FENCE';
  END IF;

  IF p_budget_charge_microusd > v_spend."reservation_microusd" THEN
    UPDATE "site_build_spend"
    SET "status" = 'UNKNOWN',
        "budget_charge_microusd" = v_spend."reservation_microusd",
        "reported_cost_microusd" = p_reported_cost_microusd,
        "calculated_cost_microusd" = p_calculated_cost_microusd,
        "estimated_cost_microusd" = p_estimated_cost_microusd,
        "cost_basis" = p_cost_basis,
        "input_tokens" = p_input_tokens,
        "output_tokens" = p_output_tokens,
        "call_count" = p_call_count,
        "result_json" = NULL,
        "meta" = p_meta,
        "error_code" = 'ACTUAL_EXCEEDED_RESERVATION',
        "settled_at" = clock_timestamp()
    WHERE "id" = v_spend."id";

    UPDATE "site_build_budget"
    SET "reserved_microusd" = GREATEST(0, "reserved_microusd" - v_spend."reservation_microusd"),
        "charged_microusd" = "charged_microusd" + v_spend."reservation_microusd",
        "paid_calls_enabled" = false,
        "disabled_reason" = 'settlement_exceeded_reservation',
        "exhausted_at" = COALESCE("exhausted_at", clock_timestamp()),
        "updated_at" = clock_timestamp()
    WHERE "build_run_id" = p_build_run_id;
    RETURN 'OVER_RESERVATION';
  END IF;

  UPDATE "site_build_spend"
  SET "status" = p_status,
      "budget_charge_microusd" = p_budget_charge_microusd,
      "reported_cost_microusd" = p_reported_cost_microusd,
      "calculated_cost_microusd" = p_calculated_cost_microusd,
      "estimated_cost_microusd" = p_estimated_cost_microusd,
      "cost_basis" = p_cost_basis,
      "input_tokens" = p_input_tokens,
      "output_tokens" = p_output_tokens,
      "call_count" = p_call_count,
      "result_json" = p_result_json,
      "meta" = p_meta,
      "error_code" = p_error_code,
      "settled_at" = clock_timestamp()
  WHERE "id" = v_spend."id";

  UPDATE "site_build_budget"
  SET "reserved_microusd" = GREATEST(0, "reserved_microusd" - v_spend."reservation_microusd"),
      "charged_microusd" = "charged_microusd" + p_budget_charge_microusd,
      "paid_calls_enabled" = CASE
        WHEN "charged_microusd" + p_budget_charge_microusd >= "cap_microusd" THEN false
        ELSE "paid_calls_enabled"
      END,
      "disabled_reason" = CASE
        WHEN "charged_microusd" + p_budget_charge_microusd >= "cap_microusd" THEN 'budget_exhausted'
        ELSE "disabled_reason"
      END,
      "exhausted_at" = CASE
        WHEN "charged_microusd" + p_budget_charge_microusd >= "cap_microusd" THEN COALESCE("exhausted_at", clock_timestamp())
        ELSE "exhausted_at"
      END,
      "updated_at" = clock_timestamp()
  WHERE "build_run_id" = p_build_run_id;
  RETURN 'SETTLED';
END
$$;
