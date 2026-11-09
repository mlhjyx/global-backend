-- P1-17：联系人工程周报快照（计划 §2.3.12，G10）。
--
-- CONTACT_WEEKLY_REPORT Schedule（注册即 paused）与 scripts/contact-weekly-report.mts
-- 每周写入一行：窗口、指标 JSON、告警评估 JSON。平台级运营表（非租户数据，无 RLS）：
-- 只有 owner/运维连接写入；app_user 按平台默认只读（继承 owner 默认 SELECT 权限，
-- 权限清单登记 ["SELECT"]），RLS 再按 workspace 限制可见性。
-- workspace_id 为 NULL 表示全租户汇总（当前周报口径）；按租户快照留作后续扩展。
-- 保留策略：运营表，按需归档（无自动清理——数据量每周 1 行）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "contact_metrics_snapshot" (
  "id" UUID NOT NULL,
  "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "window_since" TIMESTAMP(3) NOT NULL,
  "window_until" TIMESTAMP(3) NOT NULL,
  "workspace_id" UUID,
  "metrics" JSONB NOT NULL,
  "alerts" JSONB NOT NULL,
  CONSTRAINT "contact_metrics_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cms_window_check" CHECK ("window_since" < "window_until")
);

CREATE INDEX "cms_capture_idx" ON "contact_metrics_snapshot"
  ("workspace_id", "captured_at" DESC);

-- 平台级运营表但仍带租户维度（workspace_id 非空的快照）：给 RLS 契约兜底。
-- NULL 行 = 全租户汇总，只有平台上下文（current_workspace_id() IS NULL）可见；
-- owner/运维连接绕过 RLS（与既有平台表口径一致）；app_user 仅默认 SELECT。
ALTER TABLE "contact_metrics_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_metrics_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cms_tenant_isolation" ON "contact_metrics_snapshot"
  USING ("workspace_id" IS NOT DISTINCT FROM current_workspace_id())
  WITH CHECK ("workspace_id" IS NOT DISTINCT FROM current_workspace_id());

REVOKE ALL ON TABLE "contact_metrics_snapshot" FROM PUBLIC;

COMMIT;
