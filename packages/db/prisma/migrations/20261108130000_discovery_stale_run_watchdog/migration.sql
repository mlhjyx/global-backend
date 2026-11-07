-- B3（2026-11-08，审计 F2）：discovery_run 的 stale-run 看门狗需要一个跨租户枚举入口。
-- discovery_run 强制 RLS（app_user 只看得到当前 workspace），周期看门狗必须枚举所有租户
-- 里超期仍 RUNNING 的行；按 raw-retention 的既有模式提供 SECURITY DEFINER 函数：
-- 只返回标识与时间（不含业务数据），参数做范围校验，search_path 固定。

CREATE FUNCTION list_stale_discovery_runs_v1(
  p_stale_after_ms DOUBLE PRECISION,
  p_limit INTEGER
)
RETURNS TABLE(
  workspace_id UUID,
  run_id UUID,
  plan_id UUID,
  icp_id UUID,
  created_at TIMESTAMP(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_stale_after_ms IS NULL
    OR p_stale_after_ms < 0
    OR p_stale_after_ms > 604800000
    OR p_limit NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'DISCOVERY_STALE_RUN_LIST_DENIED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT run."workspace_id", run."id", run."plan_id", run."icp_id", run."created_at"
  FROM public."discovery_run" AS run
  WHERE run."status" = 'RUNNING'
    AND run."created_at" < statement_timestamp() - make_interval(secs => p_stale_after_ms / 1000.0)
  ORDER BY run."created_at"
  LIMIT p_limit;
END
$$;

REVOKE ALL ON FUNCTION list_stale_discovery_runs_v1(DOUBLE PRECISION, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_stale_discovery_runs_v1(DOUBLE PRECISION, INTEGER) TO app_user;
