-- M0⑥（Run 2.0 影子模式）：同一 run 上新旧判定的召回/一致率对比，连续两轮召回不降才切默认。
-- 只存聚合计数（不复制名单内容）；租户 RLS；app_user 只可 INSERT/SELECT（append-only）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "run_shadow_diff" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "legacy_judged" INTEGER NOT NULL,
  "legacy_positive" INTEGER NOT NULL,
  "shadow_judged" INTEGER NOT NULL,
  "shadow_positive" INTEGER NOT NULL,
  "agreement" INTEGER NOT NULL,
  "compared" INTEGER NOT NULL,
  "shadow_fallback" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "run_shadow_diff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_shadow_diff_counts_check" CHECK (
    "legacy_judged" BETWEEN 0 AND 1000000
    AND "legacy_positive" BETWEEN 0 AND "legacy_judged"
    AND "shadow_judged" BETWEEN 0 AND 1000000
    AND "shadow_positive" BETWEEN 0 AND "shadow_judged"
    AND "agreement" BETWEEN 0 AND "compared"
    AND "compared" BETWEEN 0 AND 1000000
    AND "shadow_fallback" BETWEEN 0 AND "shadow_judged"
  ),
  CONSTRAINT "run_shadow_diff_run_fkey" FOREIGN KEY ("workspace_id", "run_id")
    REFERENCES "discovery_run"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "run_shadow_diff_run_id_key" ON "run_shadow_diff"("run_id");

CREATE INDEX "run_shadow_diff_workspace_created_idx"
  ON "run_shadow_diff"("workspace_id", "created_at");

ALTER TABLE "run_shadow_diff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_shadow_diff" FORCE ROW LEVEL SECURITY;
CREATE POLICY "run_shadow_diff_tenant_isolation" ON "run_shadow_diff"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT ON TABLE "run_shadow_diff" TO app_user;

COMMIT;
