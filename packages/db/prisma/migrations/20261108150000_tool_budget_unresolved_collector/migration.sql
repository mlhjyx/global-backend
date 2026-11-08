-- B4（2026-11-08，审计 F1 + B2 遗留窗口）：未结预算操作的独立清收。
--
-- 背景：#801 的超时 RESERVED 清收挂在 raw-retention sweep 上，workspace 枚举只看
-- raw_source_record 是否当下到期（list_due_raw_retention_workspaces_v1），真实库里的孤儿
-- 预留全在枚举之外；B2 起 settle 双败会先把行标成 RESULT_UNKNOWN，而现有清收函数只认
-- RESERVED。
--
-- 审查后的关键设计点：
--   * D13 再预留（20261015045032）只重置 status/attempt/金额，**不刷新 created_at**——
--     用 created_at 做阈值会把「正在重试出网」的再预留行当成陈年孤儿释放掉，真实花费
--     变成 SETTLEMENT_CONFLICT。这里新增 `unresolved_since` 列（进入 RESERVED/
--     RESULT_UNKNOWN 的时刻，触发器维护、旧行回填 created_at），两个清收函数都按它判超期。
--   * 只处理 `amount_unit='microusd'` 行：cent 遗留行缺少 microusd 结算语义，混进批次会
--     触发形状约束使**整批回滚**（一个 workspace 的坏死行毒化其余）。cent 孤儿登记为
--     B10 三账对齐时的单独小步。
--   * 锁序与在线路径一致（先按账户 advisory、后锁 op 行），避免与 reserve/settle 互锁。
--   * 枚举带游标（p_after_workspace_id），超出单轮上限的 workspace 不会永久饿死。
--   * 平台作用域（scope_key 非租户 UUID）的孤儿不在本清收路径内（dev 库现存 3 条，B10 处理）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 进入「未结」状态的时刻。旧行回填 created_at（当时唯一的近似）；触发器在每次
-- INSERT/状态迁移到 RESERVED|RESULT_UNKNOWN 时刷新。再预留（RELEASED→RESERVED）因此
-- 重新计时，在线重试不会被清收器连坐。
ALTER TABLE public."tool_budget_operation"
  ADD COLUMN "unresolved_since" TIMESTAMPTZ;
UPDATE public."tool_budget_operation"
  SET "unresolved_since" = "created_at"
  WHERE "status" IN ('RESERVED', 'RESULT_UNKNOWN');
CREATE INDEX "tool_budget_operation_unresolved_since_idx"
  ON public."tool_budget_operation" ("unresolved_since")
  WHERE "status" IN ('RESERVED', 'RESULT_UNKNOWN');

CREATE FUNCTION touch_tool_budget_operation_unresolved_since_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."status" IN ('RESERVED', 'RESULT_UNKNOWN')
     AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status") THEN
    NEW."unresolved_since" := clock_timestamp();
  ELSIF NEW."status" NOT IN ('RESERVED', 'RESULT_UNKNOWN') THEN
    NEW."unresolved_since" := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "tool_budget_operation_unresolved_since"
BEFORE INSERT OR UPDATE OF "status" ON public."tool_budget_operation"
FOR EACH ROW EXECUTE FUNCTION touch_tool_budget_operation_unresolved_since_v1();

REVOKE ALL ON FUNCTION touch_tool_budget_operation_unresolved_since_v1() FROM PUBLIC;

-- 跨租户枚举「含未结操作」的 workspace（游标分页，防止后段饿死）。
CREATE FUNCTION list_workspaces_with_unresolved_tool_budget_v1(
  p_older_than_hours INTEGER, p_limit INTEGER, p_after_workspace_id UUID DEFAULT NULL
)
RETURNS TABLE(workspace_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
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
    AND operation."amount_unit" = 'microusd'
    AND operation."unresolved_since" < statement_timestamp() - make_interval(hours => p_older_than_hours)
    AND operation."scope_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND (p_after_workspace_id IS NULL OR operation."scope_key"::UUID > p_after_workspace_id)
  ORDER BY 1
  LIMIT p_limit;
END
$$;

REVOKE ALL ON FUNCTION list_workspaces_with_unresolved_tool_budget_v1(INTEGER, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_workspaces_with_unresolved_tool_budget_v1(INTEGER, INTEGER, UUID) TO app_user;

-- RESERVED 释放 v2：语义与既有 reconcile_stale_tool_budget_operations_v1 相同，但按
-- unresolved_since 判超期、只碰 microusd 行、先取账户 advisory 再锁行（与在线路径同锁序）。
CREATE FUNCTION reconcile_stale_tool_budget_operations_v2(
  p_workspace_id UUID, p_older_than_hours INTEGER, p_limit INTEGER
)
RETURNS TABLE(released INTEGER, has_more BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_row RECORD;
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
    OR p_older_than_hours IS NULL
    OR p_older_than_hours NOT BETWEEN 1 AND 720
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 1000
  THEN
    RAISE EXCEPTION 'TOOL_BUDGET_RECONCILE_DENIED' USING ERRCODE = '42501';
  END IF;

  FOR account_row IN
    SELECT DISTINCT account."account_key"
    FROM public."tool_budget_operation" AS operation
    JOIN public."tool_budget_account" AS account ON account."id" = operation."account_id"
    WHERE operation."scope_key" = p_workspace_id::text
      AND operation."status" = 'RESERVED'
      AND operation."amount_unit" = 'microusd'
      AND operation."unresolved_since" < authoritative_now - make_interval(hours => p_older_than_hours)
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'tool-budget-account:' || p_workspace_id::text || ':' || account_row."account_key", 0));
  END LOOP;

  FOR candidate IN
    SELECT operation."id", operation."account_id", operation."reserved_microusd"
    FROM public."tool_budget_operation" AS operation
    WHERE operation."scope_key" = p_workspace_id::text
      AND operation."status" = 'RESERVED'
      AND operation."amount_unit" = 'microusd'
      AND operation."unresolved_since" < authoritative_now - make_interval(hours => p_older_than_hours)
    ORDER BY operation."unresolved_since", operation."id"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
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
    AND operation."amount_unit" = 'microusd'
    AND operation."unresolved_since" < authoritative_now - make_interval(hours => p_older_than_hours);

  RETURN QUERY SELECT released_count, remaining > 0;
END
$$;

REVOKE ALL ON FUNCTION reconcile_stale_tool_budget_operations_v2(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_stale_tool_budget_operations_v2(UUID, INTEGER, INTEGER) TO app_user;

-- RESULT_UNKNOWN（物理已成功、结果未存证）超过活动生命周期后按**预留额**保守结清。
CREATE FUNCTION settle_unknown_tool_budget_operations_v1(
  p_workspace_id UUID, p_older_than_hours INTEGER, p_limit INTEGER
)
RETURNS TABLE(settled INTEGER, has_more BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_row RECORD;
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

  FOR account_row IN
    SELECT DISTINCT account."account_key"
    FROM public."tool_budget_operation" AS operation
    JOIN public."tool_budget_account" AS account ON account."id" = operation."account_id"
    WHERE operation."scope_key" = p_workspace_id::text
      AND operation."status" = 'RESULT_UNKNOWN'
      AND operation."amount_unit" = 'microusd'
      AND operation."unresolved_since" < authoritative_now - make_interval(hours => p_older_than_hours)
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'tool-budget-account:' || p_workspace_id::text || ':' || account_row."account_key", 0));
  END LOOP;

  FOR candidate IN
    SELECT operation."id", operation."account_id", operation."reserved_microusd"
    FROM public."tool_budget_operation" AS operation
    WHERE operation."scope_key" = p_workspace_id::text
      AND operation."status" = 'RESULT_UNKNOWN'
      AND operation."amount_unit" = 'microusd'
      AND operation."unresolved_since" < authoritative_now - make_interval(hours => p_older_than_hours)
    ORDER BY operation."unresolved_since", operation."id"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
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
    AND operation."amount_unit" = 'microusd'
    AND operation."unresolved_since" < authoritative_now - make_interval(hours => p_older_than_hours);

  RETURN QUERY SELECT settled_count, remaining > 0;
END
$$;

REVOKE ALL ON FUNCTION settle_unknown_tool_budget_operations_v1(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_unknown_tool_budget_operations_v1(UUID, INTEGER, INTEGER) TO app_user;

COMMIT;
