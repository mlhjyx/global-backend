-- 巡检（2026-11-04）：tool_budget_operation 存在 298 条 RESERVED（最早 2026-10-09），无人对账/清收。
-- 超过存活窗口的 RESERVED 是孤儿预留：占住账户可用额度，并让同一 operation_key 的重试活动撞
-- BudgetOperationReplayError（近 7 天 6 个 run 因此失败）。本函数按 workspace 批量把超时
-- RESERVED 释放（observed/charged=0，settled_at=now），与 release_tool_budget_microusd_v1 对
-- RESERVED 的释放语义一致；安全模式与 expire_personal_data_access_audit_v1 相同
-- （SECURITY DEFINER + workspace 守卫 + 与结算同源的账户 advisory 锁）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION reconcile_stale_tool_budget_operations_v1(
  p_workspace_id UUID, p_older_than_hours INTEGER, p_limit INTEGER
)
RETURNS TABLE(released INTEGER, has_more BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
-- pg_temp 必须显式排在最后（hardening 迁移 20261009160000 的守卫，security-definer-search-path.spec）。
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  candidate RECORD;
  released_count INTEGER := 0;
  remaining INTEGER;
  authoritative_now TIMESTAMPTZ := statement_timestamp();
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_older_than_hours NOT BETWEEN 1 AND 720
    OR p_limit NOT BETWEEN 1 AND 1000
  THEN
    RAISE EXCEPTION 'TOOL_BUDGET_RECONCILE_DENIED' USING ERRCODE = '42501';
  END IF;

  FOR candidate IN
    SELECT operation."id", operation."account_id", operation."reserved_microusd",
           account."account_key"
    FROM public."tool_budget_operation" AS operation
    JOIN public."tool_budget_account" AS account ON account."id" = operation."account_id"
    WHERE operation."scope_key" = p_workspace_id::text
      AND operation."status" = 'RESERVED'
      AND operation."created_at" < authoritative_now - make_interval(hours => p_older_than_hours)
    ORDER BY operation."created_at", operation."id"
    LIMIT p_limit
    FOR UPDATE OF operation SKIP LOCKED
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'tool-budget-account:' || p_workspace_id::text || ':' || candidate."account_key", 0));
    UPDATE public."tool_budget_operation" AS operation SET
      "observed_microusd" = 0,
      "charged_microusd" = 0,
      "status" = 'RELEASED',
      "settled_at" = clock_timestamp()
    WHERE operation."id" = candidate."id" AND operation."status" = 'RESERVED';
    IF FOUND THEN
      UPDATE public."tool_budget_account" AS account SET
        "reserved_microusd" = account."reserved_microusd" - candidate."reserved_microusd",
        "updated_at" = clock_timestamp()
      WHERE account."id" = candidate."account_id";
      released_count := released_count + 1;
    END IF;
  END LOOP;

  SELECT count(*)::INTEGER INTO remaining
  FROM public."tool_budget_operation" AS operation
  WHERE operation."scope_key" = p_workspace_id::text
    AND operation."status" = 'RESERVED'
    AND operation."created_at" < authoritative_now - make_interval(hours => p_older_than_hours);

  RETURN QUERY SELECT released_count, remaining > 0;
END
$$;

REVOKE ALL ON FUNCTION reconcile_stale_tool_budget_operations_v1(
  UUID, INTEGER, INTEGER
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_stale_tool_budget_operations_v1(
  UUID, INTEGER, INTEGER
) TO app_user;

COMMIT;
