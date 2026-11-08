-- B4（2026-11-08，审计 F1 + B2 遗留窗口）：未结预算操作的独立清收。
--
-- 背景：#801 的超时 RESERVED 清收挂在 raw-retention sweep 上，workspace 枚举只看
-- raw_source_record 是否当下到期（list_due_raw_retention_workspaces_v1），真实库里的孤儿
-- 预留全在枚举之外；B2 起 settle 双败会先把行标成 RESULT_UNKNOWN，而现有清收函数只认
-- RESERVED。这里按 raw-retention 的同款安全模式补两个入口：
--   1) 跨租户枚举「含未结操作」的 workspace（只看 tool_budget_operation，与 raw 记录无关）；
--   2) RESULT_UNKNOWN 超过阈值的行按预留额**保守结清**（宁可高估不可漏记）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION list_workspaces_with_unresolved_tool_budget_v1(
  p_older_than_hours INTEGER, p_limit INTEGER
)
RETURNS TABLE(workspace_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
-- pg_temp 必须显式排在最后（hardening 迁移 20261009160000 的守卫）。
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_older_than_hours IS NULL
    OR p_older_than_hours NOT BETWEEN 1 AND 720
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'TOOL_BUDGET_UNRESOLVED_LIST_DENIED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT operation."scope_key"::UUID
  FROM public."tool_budget_operation" AS operation
  WHERE operation."status" IN ('RESERVED', 'RESULT_UNKNOWN')
    AND operation."created_at" < statement_timestamp() - make_interval(hours => p_older_than_hours)
    -- 只枚举租户作用域（canonical UUID）；平台作用域的孤儿不走租户清收路径。
    AND operation."scope_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ORDER BY 1
  LIMIT p_limit;
END
$$;

REVOKE ALL ON FUNCTION list_workspaces_with_unresolved_tool_budget_v1(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_workspaces_with_unresolved_tool_budget_v1(INTEGER, INTEGER) TO app_user;

-- RESULT_UNKNOWN（物理已成功、结果未存证）超过活动生命周期后按**预留额**保守结清：
-- observed=charged=reserved_microusd，账户 reserved 释放、charged 增加。与 settle/release
-- 同源：workspace 守卫 + 逐账号 advisory lock（与 settle_tool_budget 相同的锁键）。
CREATE FUNCTION settle_unknown_tool_budget_operations_v1(
  p_workspace_id UUID, p_older_than_hours INTEGER, p_limit INTEGER
)
RETURNS TABLE(settled INTEGER, has_more BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  candidate RECORD;
  settled_count INTEGER := 0;
  remaining INTEGER;
  authoritative_now TIMESTAMPTZ := statement_timestamp();
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_older_than_hours IS NULL
    OR p_older_than_hours NOT BETWEEN 1 AND 720
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 1000
  THEN
    RAISE EXCEPTION 'TOOL_BUDGET_UNKNOWN_SETTLE_DENIED' USING ERRCODE = '42501';
  END IF;

  FOR candidate IN
    SELECT operation."id", operation."account_id", operation."reserved_microusd",
           account."account_key"
    FROM public."tool_budget_operation" AS operation
    JOIN public."tool_budget_account" AS account ON account."id" = operation."account_id"
    WHERE operation."scope_key" = p_workspace_id::text
      AND operation."status" = 'RESULT_UNKNOWN'
      AND operation."created_at" < authoritative_now - make_interval(hours => p_older_than_hours)
    ORDER BY operation."created_at", operation."id"
    LIMIT p_limit
    FOR UPDATE OF operation SKIP LOCKED
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'tool-budget-account:' || p_workspace_id::text || ':' || candidate."account_key", 0));
    UPDATE public."tool_budget_operation" AS operation SET
      "observed_microusd" = candidate."reserved_microusd",
      "charged_microusd" = candidate."reserved_microusd",
      "status" = 'SETTLED',
      "settled_at" = clock_timestamp()
    WHERE operation."id" = candidate."id" AND operation."status" = 'RESULT_UNKNOWN';
    IF FOUND THEN
      UPDATE public."tool_budget_account" AS account SET
        "reserved_microusd" = account."reserved_microusd" - candidate."reserved_microusd",
        "charged_microusd" = account."charged_microusd" + candidate."reserved_microusd",
        "updated_at" = clock_timestamp()
      WHERE account."id" = candidate."account_id";
      settled_count := settled_count + 1;
    END IF;
  END LOOP;

  SELECT count(*)::INTEGER INTO remaining
  FROM public."tool_budget_operation" AS operation
  WHERE operation."scope_key" = p_workspace_id::text
    AND operation."status" = 'RESULT_UNKNOWN'
    AND operation."created_at" < authoritative_now - make_interval(hours => p_older_than_hours);

  RETURN QUERY SELECT settled_count, remaining > 0;
END
$$;

REVOKE ALL ON FUNCTION settle_unknown_tool_budget_operations_v1(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_unknown_tool_budget_operations_v1(UUID, INTEGER, INTEGER) TO app_user;

COMMIT;
