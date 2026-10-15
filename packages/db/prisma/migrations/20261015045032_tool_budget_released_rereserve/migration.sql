-- D13: a released operation key may be reserved again, at most three attempts.
--
-- RELEASED means the ledger proved no physical cost was incurred: a pre-wire
-- control denial, or (since this change) a definite failure the gateway did
-- not bill: an HTTP 429 or 5xx status other than the 504/524 timeouts, or a
-- connection that never opened. Stream failures are not released. Until now
-- reserve replayed every existing key, so a released operation could never run
-- again and each retry ended in BUDGET_OPERATION_REPLAY_UNAVAILABLE: a definite,
-- free failure became the end of the run item.
--
-- reserve now reopens the same row when it is RELEASED and has fewer than three
-- attempts: status back to RESERVED, attempt + 1, the new reservation amount,
-- and the same budget check and DENIED/exhausted behaviour as a fresh insert.
-- The row keeps its id, so (account_id, generation, operation_key) stays
-- unique and every reference to the operation id stays valid. RESERVED,
-- RESULT_UNKNOWN and SETTLED rows (with or without a result) still replay
-- exactly as before: an operation whose outcome is unknown is never paid twice.
-- A released row at its third attempt also replays, which bounds the physical
-- retries per key.
--
-- Only reserve_tool_budget_microusd_v1 changes; its signature, return shape,
-- owner, grants and the wrappers reserve_tool_budget_microusd_with_receipt_v1 /
-- reserve_tool_budget stay as they are. Forward-only; existing rows get
-- attempt = 1.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "tool_budget_operation"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tool_budget_operation"
  ADD CONSTRAINT "tool_budget_operation_attempt_check"
  CHECK ("attempt" BETWEEN 1 AND 3);

CREATE OR REPLACE FUNCTION reserve_tool_budget_microusd_v1(
  p_scope_key TEXT,
  p_account_key TEXT,
  p_operation_key TEXT,
  p_reservation_microusd BIGINT
)
RETURNS TABLE(
  kind TEXT, operation_id UUID, reserved_microusd BIGINT,
  remaining_microusd BIGINT, status TEXT, result_json JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account "tool_budget_account"%ROWTYPE;
  operation "tool_budget_operation"%ROWTYPE;
  cap_microusd BIGINT;
  remaining BIGINT;
BEGIN
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  IF char_length(p_operation_key) NOT BETWEEN 1 AND 200
    OR p_reservation_microusd IS NULL OR p_reservation_microusd < 0
  THEN RAISE EXCEPTION 'invalid tool budget microusd reservation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||p_account_key,0));
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key
    AND target."account_key" = p_account_key
  FOR UPDATE;
  IF account."id" IS NULL OR account."ref_count" = 0 THEN
    IF account."id" IS NOT NULL AND account."authority_id" IS NULL THEN
      RAISE EXCEPTION 'TOOL_BUDGET_HISTORICAL_TERMINAL'
        USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'TOOL_BUDGET_ACCOUNT_UNAVAILABLE';
  END IF;
  cap_microusd := tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  IF account."exhausted" THEN
    RETURN QUERY SELECT 'DENIED', NULL::UUID, 0::BIGINT,
      GREATEST(0::BIGINT, cap_microusd-account."reserved_microusd"-account."charged_microusd"),
      'EXHAUSTED', NULL::JSONB;
    RETURN;
  END IF;
  PERFORM * FROM attest_authorized_tool_budget_v1(
    p_scope_key, account."authority_id", p_account_key
  );
  IF account."charged_microusd" > cap_microusd
    OR account."reserved_microusd" > cap_microusd-account."charged_microusd"
  THEN RAISE EXCEPTION 'TOOL_BUDGET_MICROUSD_INVARIANT'; END IF;
  remaining := cap_microusd-account."reserved_microusd"-account."charged_microusd";
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."account_id" = account."id"
    AND target."generation" = account."generation"
    AND target."operation_key" = p_operation_key
  FOR UPDATE;
  IF operation."id" IS NOT NULL THEN
    IF operation."amount_unit" <> 'microusd' THEN
      RAISE EXCEPTION 'TOOL_BUDGET_AMOUNT_UNIT_CONFLICT';
    END IF;
    -- D13: only a released row below the attempt bound may run again.
    IF operation."status" <> 'RELEASED' OR operation."attempt" >= 3 THEN
      RETURN QUERY SELECT 'REPLAY', operation."id", operation."reserved_microusd",
        remaining, operation."status"::text, operation."result_json";
      RETURN;
    END IF;
    IF p_reservation_microusd > remaining THEN
      UPDATE "tool_budget_account" target
      SET "exhausted" = true, "updated_at" = clock_timestamp()
      WHERE target."id" = account."id";
      RETURN QUERY SELECT 'DENIED', NULL::UUID, 0::BIGINT, remaining,
        'EXHAUSTED', NULL::JSONB;
      RETURN;
    END IF;
    UPDATE "tool_budget_operation" target SET
      "status" = 'RESERVED',
      "attempt" = target."attempt" + 1,
      "reserved_microusd" = p_reservation_microusd,
      "observed_microusd" = NULL,
      "charged_microusd" = NULL,
      "settled_at" = NULL
    WHERE target."id" = operation."id" AND target."status" = 'RELEASED'
    RETURNING target.* INTO operation;
    UPDATE "tool_budget_account" target
    SET "reserved_microusd" = target."reserved_microusd"+p_reservation_microusd,
        "updated_at" = clock_timestamp()
    WHERE target."id" = account."id" RETURNING target.* INTO account;
    RETURN QUERY SELECT 'EXECUTE', operation."id", operation."reserved_microusd",
      cap_microusd-account."reserved_microusd"-account."charged_microusd",
      operation."status"::text, NULL::JSONB;
    RETURN;
  END IF;
  IF p_reservation_microusd > remaining THEN
    UPDATE "tool_budget_account" target
    SET "exhausted" = true, "updated_at" = clock_timestamp()
    WHERE target."id" = account."id";
    RETURN QUERY SELECT 'DENIED', NULL::UUID, 0::BIGINT, remaining,
      'EXHAUSTED', NULL::JSONB;
    RETURN;
  END IF;
  INSERT INTO "tool_budget_operation"(
    "scope_key", "account_id", "generation", "operation_key",
    "amount_unit", "reserved_cents", "reserved_microusd"
  ) VALUES (
    p_scope_key, account."id", account."generation", p_operation_key,
    'microusd', 0, p_reservation_microusd
  ) RETURNING * INTO operation;
  UPDATE "tool_budget_account" target
  SET "reserved_microusd" = target."reserved_microusd"+p_reservation_microusd,
      "updated_at" = clock_timestamp()
  WHERE target."id" = account."id" RETURNING target.* INTO account;
  RETURN QUERY SELECT 'EXECUTE', operation."id", operation."reserved_microusd",
    cap_microusd-account."reserved_microusd"-account."charged_microusd",
    operation."status"::text, NULL::JSONB;
END
$$;

COMMIT;
