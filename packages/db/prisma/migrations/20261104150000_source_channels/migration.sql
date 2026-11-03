-- M1（渠道数据源平台，2026-11-04 设计与 Q27 调整）：
--   * source_channel：平台级渠道注册表（api | crawl | import 三形态），治理硬闸门字段；
--   * source_channel_enablement：租户只能启用已批准渠道（每 workspace × 渠道一行）；
--   * source_channel_run：每次试跑/运行的抓取量/产出/失败率（失败率连续 3 轮 >30% 自动停用）；
--   * imported_buyer：租户私有导入的原始行与去重键（不共享）；
--   * company_channel_sighting.channel_id 接上 source_channel 外键（M0① 先建表、M1 接线）。
-- Additive, no backfill.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "source_channel" (
  "id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "mode" VARCHAR(16) NOT NULL,
  "category" VARCHAR(32) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'DISABLED',
  "config" JSONB NOT NULL,
  "license" VARCHAR(200),
  "tos_url" VARCHAR(2048),
  "robots_policy" VARCHAR(8),
  "owner" VARCHAR(200),
  "failure_streak" INTEGER NOT NULL DEFAULT 0,
  "last_run_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "source_channel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_channel_name_check" CHECK (char_length("name") BETWEEN 1 AND 200),
  CONSTRAINT "source_channel_mode_check" CHECK ("mode" IN ('api', 'crawl', 'import')),
  CONSTRAINT "source_channel_category_check" CHECK (
    "category" IN ('trade_fair', 'customs', 'association', 'directory', 'tender', 'other')
  ),
  CONSTRAINT "source_channel_status_check" CHECK ("status" IN ('DISABLED', 'ENABLED', 'AUTO_DISABLED')),
  CONSTRAINT "source_channel_robots_check" CHECK (
    "robots_policy" IS NULL OR "robots_policy" IN ('A', 'B', 'C')
  ),
  CONSTRAINT "source_channel_tos_check" CHECK (
    "tos_url" IS NULL OR "tos_url" LIKE 'https://%'
  ),
  CONSTRAINT "source_channel_streak_check" CHECK ("failure_streak" BETWEEN 0 AND 100)
);

CREATE INDEX "source_channel_status_category_idx"
  ON "source_channel"("status", "category");

CREATE TABLE "source_channel_enablement" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "enabled_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "source_channel_enablement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_channel_enablement_channel_fkey" FOREIGN KEY ("channel_id")
    REFERENCES "source_channel"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "source_channel_enablement_workspace_channel_key"
  ON "source_channel_enablement"("workspace_id", "channel_id");

CREATE INDEX "source_channel_enablement_workspace_idx"
  ON "source_channel_enablement"("workspace_id");

ALTER TABLE "source_channel_enablement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_channel_enablement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "source_channel_enablement_tenant_isolation" ON "source_channel_enablement"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

CREATE TABLE "source_channel_run" (
  "id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "workspace_id" UUID,
  "status" VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
  "pages_fetched" INTEGER NOT NULL DEFAULT 0,
  "records_found" INTEGER NOT NULL DEFAULT 0,
  "records_materialized" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(64),
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(3),

  CONSTRAINT "source_channel_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_channel_run_status_check" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT "source_channel_run_counts_check" CHECK (
    "pages_fetched" BETWEEN 0 AND 1000000
    AND "records_found" BETWEEN 0 AND 1000000
    AND "records_materialized" BETWEEN 0 AND 1000000
    AND "failures" BETWEEN 0 AND 1000000
  ),
  CONSTRAINT "source_channel_run_channel_fkey" FOREIGN KEY ("channel_id")
    REFERENCES "source_channel"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "source_channel_run_channel_started_idx"
  ON "source_channel_run"("channel_id", "started_at");

CREATE TABLE "imported_buyer" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "channel_id" UUID,
  "row_number" INTEGER NOT NULL,
  "raw_row" JSONB NOT NULL,
  "dedupe_key" VARCHAR(200) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'MATERIALIZED',
  "canonical_company_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "imported_buyer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "imported_buyer_status_check" CHECK ("status" IN ('MATERIALIZED', 'DUPLICATE', 'SUPPRESSED')),
  CONSTRAINT "imported_buyer_row_check" CHECK ("row_number" BETWEEN 1 AND 1000000),
  CONSTRAINT "imported_buyer_dedupe_check" CHECK (char_length("dedupe_key") BETWEEN 1 AND 200)
);

CREATE INDEX "imported_buyer_workspace_batch_idx"
  ON "imported_buyer"("workspace_id", "batch_id");

CREATE INDEX "imported_buyer_workspace_dedupe_idx"
  ON "imported_buyer"("workspace_id", "dedupe_key");

ALTER TABLE "imported_buyer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "imported_buyer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "imported_buyer_tenant_isolation" ON "imported_buyer"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- 平台级渠道注册表**不含租户个人数据**：不启用 RLS（RLS 无租户列可依），
-- 写入由引擎 API 的 acquisition:write scope 闸门（BFF 管理员路由）把关；租户启用走 enablement 表。
GRANT SELECT, INSERT, UPDATE ON TABLE "source_channel" TO app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "source_channel_run" TO app_user;
GRANT SELECT, INSERT, DELETE ON TABLE "source_channel_enablement" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "imported_buyer" TO app_user;

-- M1：渠道 sightings 接外键（M0① 建表时 channel_id 无外键）。
ALTER TABLE "company_channel_sighting"
  ADD CONSTRAINT "company_channel_sighting_channel_fkey" FOREIGN KEY ("channel_id")
    REFERENCES "source_channel"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

COMMIT;
