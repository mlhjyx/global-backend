-- P1-08（联系人工程）：富集尝试账 contact_enrichment_attempt。
--
-- 设计依据：《GainOS 深化计划 v3.0》第 2 章 §2.3.4.5/§2.3.4.6；
-- 仓内计划 docs/superpowers/plans/2026-11-09-contact-point-four-state.md（P1 lane）。
--
-- 每次 finder 调用一行——hit / miss / error / skipped_budget / skipped_compliance 都记，
-- 成本照记（micro-USD 整数）。唯一键 (workspace, provider, request_hash) 是幂等键：
-- 同一输入版本（姓名/域/公司名/LinkedIn）重跑不重扣；输入变化才产生新行。
-- 90 天命中缓存与 24h 失败缓存由读取侧按 attempted_at 判断（不建部分索引：
-- Prisma datamodel 无法表达，漂移门零容忍）。
-- email_state 在验证瀑布完成后回填（同一次富集的最终四态；未验证/被预算跳过为 NULL）。
--
-- 租户隔离：RLS（与 contact_point_verification_event 同策略形状）；app_user 可
-- SELECT/INSERT/UPDATE（email_state 回填需要 UPDATE；本表是运行账，不承诺 append-only）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "contact_enrichment_attempt" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "provider_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "error_code" TEXT,
  "retryable" BOOLEAN,
  "cost_microusd" BIGINT NOT NULL DEFAULT 0,
  "latency_ms" INTEGER NOT NULL DEFAULT 0,
  "email_state" TEXT,
  "evidence" JSONB,
  "run_id" TEXT,
  "account_key" TEXT NOT NULL,
  "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_enrichment_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cea_outcome_check" CHECK ("outcome" IN
    ('hit', 'miss', 'error', 'skipped_budget', 'skipped_compliance')),
  CONSTRAINT "cea_email_state_check" CHECK ("email_state" IS NULL OR "email_state" IN
    ('VALID', 'INVALID', 'CATCH_ALL_RISKY', 'UNKNOWN')),
  CONSTRAINT "cea_cost_check" CHECK ("cost_microusd" >= 0),
  CONSTRAINT "cea_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  -- ON UPDATE CASCADE 与 Prisma relation 的默认 onUpdate 动作一致（漂移门零容忍）。
  CONSTRAINT "contact_enrichment_attempt_contact_id_fkey" FOREIGN KEY ("contact_id")
    REFERENCES "canonical_contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cea_unique_request" UNIQUE ("workspace_id", "provider_key", "request_hash")
);

CREATE INDEX "cea_contact_time_idx" ON "contact_enrichment_attempt"
  ("workspace_id", "contact_id", "attempted_at" DESC);
CREATE INDEX "cea_provider_time_idx" ON "contact_enrichment_attempt"
  ("workspace_id", "provider_key", "attempted_at");

ALTER TABLE "contact_enrichment_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_enrichment_attempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cea_tenant_isolation" ON "contact_enrichment_attempt"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "contact_enrichment_attempt" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE "contact_enrichment_attempt" TO app_user;

COMMIT;
