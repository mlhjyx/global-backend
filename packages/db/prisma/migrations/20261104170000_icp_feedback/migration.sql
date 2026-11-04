-- M2（反馈闭环，设计 §7.1）：判断 → 聚合 → 查询权重与 ICP 建议卡（人工采纳才改 ICP）。
--   * icp_feedback：按来源/渠道/行业/国家的接受率与 mismatch 理由分布；
--   * icp_query_performance：查询族（当前按来源类目聚合）的 EMA 质量分，供规划时加权。
-- Additive, no backfill.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "icp_feedback" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "icp_id" UUID NOT NULL,
  "dimension" VARCHAR(16) NOT NULL,
  "dimension_key" VARCHAR(200) NOT NULL,
  "accepted" INTEGER NOT NULL DEFAULT 0,
  "rejected" INTEGER NOT NULL DEFAULT 0,
  "reason_counts" JSONB,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "icp_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "icp_feedback_dimension_check" CHECK ("dimension" IN ('source', 'channel', 'industry', 'country')),
  CONSTRAINT "icp_feedback_counts_check" CHECK ("accepted" >= 0 AND "rejected" >= 0),
  CONSTRAINT "icp_feedback_key_check" CHECK (char_length("dimension_key") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "icp_feedback_identity_key"
  ON "icp_feedback"("workspace_id", "icp_id", "dimension", "dimension_key");

CREATE INDEX "icp_feedback_workspace_icp_idx"
  ON "icp_feedback"("workspace_id", "icp_id");

ALTER TABLE "icp_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "icp_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY "icp_feedback_tenant_isolation" ON "icp_feedback"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "icp_feedback" TO app_user;

CREATE TABLE "icp_query_performance" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "icp_id" UUID NOT NULL,
  "query_family" VARCHAR(200) NOT NULL,
  "samples" INTEGER NOT NULL DEFAULT 0,
  "accepted" INTEGER NOT NULL DEFAULT 0,
  "quality_ema" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "icp_query_performance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "icp_query_performance_family_check" CHECK (char_length("query_family") BETWEEN 1 AND 200),
  CONSTRAINT "icp_query_performance_counts_check" CHECK ("samples" >= 0 AND "accepted" >= 0 AND "quality_ema" BETWEEN 0 AND 1)
);

CREATE UNIQUE INDEX "icp_query_performance_identity_key"
  ON "icp_query_performance"("workspace_id", "icp_id", "query_family");

CREATE INDEX "icp_query_performance_workspace_icp_idx"
  ON "icp_query_performance"("workspace_id", "icp_id");

ALTER TABLE "icp_query_performance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "icp_query_performance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "icp_query_performance_tenant_isolation" ON "icp_query_performance"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "icp_query_performance" TO app_user;

COMMIT;
