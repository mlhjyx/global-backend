-- PR0（2026-11-04，决策 Q25「取消租户数据处理声明」的补偿控制）：
--   * personal_data_access_audit: 个人数据每次访问/物化写一行（谁/何时/公司/字段类/用途），
--     租户 RLS，append-only（app_user 仅 SELECT/INSERT），保留 180 天。
--   * 内容最小化：只记主体计数与字段类别，绝不存字段值或人名明文。
--   * expire_personal_data_access_audit_v1: 按 workspace 批量删除超过保留期的行，
--     由 raw-retention sweep 调用（与 expire_due_raw_source_records_v1 同一安全模式）。
-- Additive, no backfill. Deploy in name order, in the same window as the image carrying it.
-- Rollback: a later migration that drops the function then the table (nothing references it).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "personal_data_access_audit" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "actor_id" VARCHAR(200) NOT NULL,
  "actor_kind" VARCHAR(16) NOT NULL,
  "purpose" VARCHAR(48) NOT NULL,
  "company_id" UUID,
  "field_classes" TEXT[] NOT NULL,
  "subject_count" INTEGER NOT NULL DEFAULT 0,
  "lawful_basis_ref" VARCHAR(512),
  "correlation_id" VARCHAR(200),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "personal_data_access_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "personal_data_access_audit_actor_kind_check" CHECK (
    "actor_kind" IN ('user', 'system', 'platform')
  ),
  CONSTRAINT "personal_data_access_audit_purpose_check" CHECK (
    "purpose" IN (
      'contact_discovery',
      'email_guess',
      'email_verification',
      'run_contact_materialization',
      'run_email_guess'
    )
  ),
  CONSTRAINT "personal_data_access_audit_actor_check" CHECK (
    char_length("actor_id") BETWEEN 1 AND 200
  ),
  CONSTRAINT "personal_data_access_audit_field_classes_check" CHECK (
    cardinality("field_classes") BETWEEN 1 AND 16
  ),
  CONSTRAINT "personal_data_access_audit_subject_count_check" CHECK (
    "subject_count" BETWEEN 0 AND 1000000
  ),
  CONSTRAINT "personal_data_access_audit_lawful_basis_check" CHECK (
    "lawful_basis_ref" IS NULL
    OR char_length("lawful_basis_ref") BETWEEN 1 AND 512
  ),
  CONSTRAINT "personal_data_access_audit_correlation_check" CHECK (
    "correlation_id" IS NULL
    OR char_length("correlation_id") BETWEEN 1 AND 200
  )
);

CREATE INDEX "personal_data_access_audit_workspace_created_idx"
  ON "personal_data_access_audit"("workspace_id", "created_at");

CREATE INDEX "personal_data_access_audit_workspace_company_created_idx"
  ON "personal_data_access_audit"("workspace_id", "company_id", "created_at");

ALTER TABLE "personal_data_access_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_data_access_audit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "personal_data_access_audit_tenant_isolation" ON "personal_data_access_audit"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- append-only：app_user 只可写入与读取；UPDATE/DELETE 一律不授予（清理走 SECURITY DEFINER 函数）。
GRANT SELECT, INSERT ON TABLE "personal_data_access_audit" TO app_user;

-- 保留期清理：按 workspace 分批删除 created_at 早于 retention 的行。
-- 安全模式与 expire_due_raw_source_records_v1 一致：仅 app_user 经同 workspace 的
-- withWorkspace 事务可调用（SECURITY DEFINER 以函数属主身份执行 DELETE，绕过无 DELETE 授权）。
CREATE FUNCTION expire_personal_data_access_audit_v1(
  p_workspace_id UUID, p_retention_days INTEGER, p_limit INTEGER
)
RETURNS TABLE(
  expired INTEGER,
  has_more BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
-- pg_temp 必须显式排在最后：未列出时 PostgreSQL 会先搜 pg_temp，临时表可遮蔽 public 表
-- （hardening 迁移 20261009160000 的守卫，security-definer-search-path.spec.ts）。
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  changed INTEGER;
  remaining INTEGER;
  authoritative_now TIMESTAMPTZ := statement_timestamp();
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_retention_days NOT BETWEEN 1 AND 3650
    OR p_limit NOT BETWEEN 1 AND 5000
  THEN
    RAISE EXCEPTION 'PERSONAL_DATA_ACCESS_AUDIT_RETENTION_DENIED' USING ERRCODE = '42501';
  END IF;

  WITH candidates AS (
    SELECT audit."id"
    FROM public."personal_data_access_audit" AS audit
    WHERE audit."workspace_id" = p_workspace_id
      AND audit."created_at" < authoritative_now - make_interval(days => p_retention_days)
    ORDER BY audit."created_at", audit."id"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public."personal_data_access_audit" AS audit
    USING candidates
    WHERE audit."id" = candidates."id"
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO changed FROM deleted;

  SELECT count(*)::INTEGER INTO remaining
  FROM public."personal_data_access_audit" AS audit
  WHERE audit."workspace_id" = p_workspace_id
    AND audit."created_at" < authoritative_now - make_interval(days => p_retention_days);

  RETURN QUERY SELECT changed, remaining > 0;
END
$$;

REVOKE ALL ON FUNCTION expire_personal_data_access_audit_v1(
  UUID, INTEGER, INTEGER
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_personal_data_access_audit_v1(
  UUID, INTEGER, INTEGER
) TO app_user;

COMMIT;
