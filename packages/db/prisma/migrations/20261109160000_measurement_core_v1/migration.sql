-- ch01（测量与真值）PR-02：度量四表。
--
-- 设计依据：《GainOS 深化计划 v3.0》第 1 章 §3.6.3（metric_definition /
-- metric_observation / metric_rollup_daily / metric_rollup_weekly 的 DDL），
-- Prisma datamodel 同步于 packages/db/prisma/schema.prisma。
--
-- 与设计稿的有意差异（评审时注意）：
--  * Prisma 不支持 Json 字段进入主键/唯一约束。设计稿里 rollup 两表的主键与
--    metric_observation 的唯一键包含 stratum jsonb；这里并列增加
--    stratum_key TEXT（应用层写入「排序键规范化的 JSON 文本」），
--    主键/唯一键改用 stratum_key；stratum 仍保留为查询载荷。
--  * 数值列用 NUMERIC(20,6)（设计稿为裸 numeric）：与 Prisma Decimal(20,6)
--    精确对齐，避免 migrate diff 漂移；比率/成本 6 位小数足够。
--  * 时间戳统一 TIMESTAMPTZ(3)，与仓库既有表一致。
--
-- 权限语义（与 docs/governance/app-user-table-privileges.json 对账）：
--  * metric_definition 是平台工件：app_user 仅 SELECT（写入属 owner/ops）；
--  * metric_observation append-only：app_user SELECT, INSERT；无 UPDATE/DELETE。
--    workspace_id IS NULL 的平台行对租户不可见，app_user 也不能写（WITH CHECK）；
--  * metric_rollup_daily / metric_rollup_weekly 是物化聚合表：app_user
--    SELECT, INSERT, UPDATE（INSERT ... ON CONFLICT DO UPDATE 需要），无 DELETE；
--    两表没有 workspace 列（遵循设计稿），租户行的 workspace 以
--    stratum->>'workspace_id' 表达，RLS 用该表达式过滤与校验；
--    平台行（stratum 不含 workspace_id）对租户不可见。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ① 指标字典（平台工件，带版本；删除指标用 RETIRED 不删行）。
CREATE TABLE "metric_definition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "metric_id" VARCHAR(32) NOT NULL,
  "version" INTEGER NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "tier" VARCHAR(16) NOT NULL,
  "unit" VARCHAR(16) NOT NULL,
  "definition" TEXT NOT NULL,
  "numerator_expr" TEXT NOT NULL,
  "denominator_expr" TEXT,
  "exclusions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "window_spec" JSONB NOT NULL,
  "strata" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "owner" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  "effective_from" TIMESTAMPTZ(3) NOT NULL,
  "changelog" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "content_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "metric_definition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "metric_definition_metric_id_version_key" UNIQUE ("metric_id", "version"),
  CONSTRAINT "metric_definition_status_check"
    CHECK ("status" IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED')),
  CONSTRAINT "metric_definition_tier_check"
    CHECK ("tier" IN ('T0', 'T1', 'T2', 'T3', 'T4', 'GUARDRAIL')),
  CONSTRAINT "metric_definition_version_check" CHECK ("version" >= 1)
);
CREATE INDEX "metric_definition_status_idx" ON "metric_definition" ("status");

-- ② 指标观测（append-only；平台级行 workspace_id IS NULL）。
CREATE TABLE "metric_observation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID,
  "metric_id" VARCHAR(32) NOT NULL,
  "metric_version" INTEGER NOT NULL,
  "stratum" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "stratum_key" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "window_end" TIMESTAMPTZ(3) NOT NULL,
  "numerator" NUMERIC(20, 6) NOT NULL,
  "denominator" NUMERIC(20, 6),
  "value" NUMERIC(20, 6) NOT NULL,
  "ci_low" NUMERIC(20, 6),
  "ci_high" NUMERIC(20, 6),
  "sample_n" INTEGER,
  "source_event_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "computation_hash" CHAR(64) NOT NULL,
  "supersedes_id" UUID,
  "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "metric_observation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "metric_observation_stratum_check" CHECK (jsonb_typeof("stratum") = 'object'),
  CONSTRAINT "metric_observation_window_check" CHECK ("window_end" >= "window_start"),
  CONSTRAINT "metric_observation_sample_check" CHECK ("sample_n" IS NULL OR "sample_n" >= 0)
);
ALTER TABLE "metric_observation"
  ADD CONSTRAINT "metric_observation_identity_key"
  UNIQUE ("metric_id", "metric_version", "stratum_key",
          "window_start", "window_end", "computation_hash");
CREATE INDEX "metric_observation_lookup_idx"
  ON "metric_observation" ("metric_id", "window_end" DESC);
CREATE INDEX "metric_observation_workspace_idx"
  ON "metric_observation" ("workspace_id", "window_end" DESC);

ALTER TABLE "metric_observation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metric_observation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "metric_observation_tenant" ON "metric_observation"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- append-only：SELECT + INSERT，无 UPDATE/DELETE。
REVOKE ALL ON TABLE "metric_observation" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "metric_observation" FROM app_user;
GRANT SELECT, INSERT ON TABLE "metric_observation" TO app_user;

-- ③ 日聚合（可由 observation 重算；物化表，可 upsert）。
CREATE TABLE "metric_rollup_daily" (
  "day" DATE NOT NULL,
  "metric_id" VARCHAR(32) NOT NULL,
  "metric_version" INTEGER NOT NULL,
  "stratum" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "stratum_key" TEXT NOT NULL,
  "numerator" NUMERIC(20, 6) NOT NULL,
  "denominator" NUMERIC(20, 6),
  "value" NUMERIC(20, 6) NOT NULL,
  "ci_low" NUMERIC(20, 6),
  "ci_high" NUMERIC(20, 6),
  "sample_n" INTEGER,
  "refreshed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "metric_rollup_daily_pkey" PRIMARY KEY ("day", "metric_id", "metric_version", "stratum_key"),
  CONSTRAINT "metric_rollup_daily_stratum_check" CHECK (jsonb_typeof("stratum") = 'object')
);
CREATE INDEX "metric_rollup_daily_metric_idx"
  ON "metric_rollup_daily" ("metric_id", "day" DESC);
CREATE INDEX "metric_rollup_daily_workspace_idx"
  ON "metric_rollup_daily" ((("stratum" ->> 'workspace_id')));

ALTER TABLE "metric_rollup_daily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metric_rollup_daily" FORCE ROW LEVEL SECURITY;
CREATE POLICY "metric_rollup_daily_tenant" ON "metric_rollup_daily"
  USING (("stratum" ->> 'workspace_id') = current_workspace_id()::text)
  WITH CHECK (("stratum" ->> 'workspace_id') = current_workspace_id()::text);

-- 物化表：SELECT + INSERT + UPDATE（upsert），无 DELETE。
REVOKE ALL ON TABLE "metric_rollup_daily" FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "metric_rollup_daily" FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "metric_rollup_daily" TO app_user;

-- ④ 周聚合（ISO 周，周一为 week 值）。
CREATE TABLE "metric_rollup_weekly" (
  "week" DATE NOT NULL,
  "metric_id" VARCHAR(32) NOT NULL,
  "metric_version" INTEGER NOT NULL,
  "stratum" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "stratum_key" TEXT NOT NULL,
  "numerator" NUMERIC(20, 6) NOT NULL,
  "denominator" NUMERIC(20, 6),
  "value" NUMERIC(20, 6) NOT NULL,
  "ci_low" NUMERIC(20, 6),
  "ci_high" NUMERIC(20, 6),
  "sample_n" INTEGER,
  "refreshed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "metric_rollup_weekly_pkey" PRIMARY KEY ("week", "metric_id", "metric_version", "stratum_key"),
  CONSTRAINT "metric_rollup_weekly_stratum_check" CHECK (jsonb_typeof("stratum") = 'object')
);
CREATE INDEX "metric_rollup_weekly_metric_idx"
  ON "metric_rollup_weekly" ("metric_id", "week" DESC);
CREATE INDEX "metric_rollup_weekly_workspace_idx"
  ON "metric_rollup_weekly" ((("stratum" ->> 'workspace_id')));

ALTER TABLE "metric_rollup_weekly" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metric_rollup_weekly" FORCE ROW LEVEL SECURITY;
CREATE POLICY "metric_rollup_weekly_tenant" ON "metric_rollup_weekly"
  USING (("stratum" ->> 'workspace_id') = current_workspace_id()::text)
  WITH CHECK (("stratum" ->> 'workspace_id') = current_workspace_id()::text);

REVOKE ALL ON TABLE "metric_rollup_weekly" FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "metric_rollup_weekly" FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "metric_rollup_weekly" TO app_user;

-- metric_definition 是平台工件：app_user 只读。
REVOKE ALL ON TABLE "metric_definition" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "metric_definition" FROM app_user;
GRANT SELECT ON TABLE "metric_definition" TO app_user;

COMMIT;
