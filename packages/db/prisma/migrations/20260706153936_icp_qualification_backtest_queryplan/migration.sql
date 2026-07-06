-- CreateEnum
CREATE TYPE "rule_kind" AS ENUM ('MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION');

-- CreateTable
CREATE TABLE "qualification_rule" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "kind" "rule_kind" NOT NULL,
    "field" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rationale" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qualification_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "icp_backtest" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "samples" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "icp_backtest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_query_plan" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "queries" JSONB NOT NULL,
    "estimated_volume" INTEGER,
    "estimated_cost_cents" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_query_plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "qualification_rule_workspace_id_idx" ON "qualification_rule"("workspace_id");

-- CreateIndex
CREATE INDEX "qualification_rule_icp_id_idx" ON "qualification_rule"("icp_id");

-- CreateIndex
CREATE INDEX "icp_backtest_workspace_id_idx" ON "icp_backtest"("workspace_id");

-- CreateIndex
CREATE INDEX "icp_backtest_icp_id_idx" ON "icp_backtest"("icp_id");

-- CreateIndex
CREATE INDEX "discovery_query_plan_workspace_id_idx" ON "discovery_query_plan"("workspace_id");

-- CreateIndex
CREATE INDEX "discovery_query_plan_icp_id_idx" ON "discovery_query_plan"("icp_id");

-- AddForeignKey
ALTER TABLE "qualification_rule" ADD CONSTRAINT "qualification_rule_icp_id_fkey" FOREIGN KEY ("icp_id") REFERENCES "icp_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "icp_backtest" ADD CONSTRAINT "icp_backtest_icp_id_fkey" FOREIGN KEY ("icp_id") REFERENCES "icp_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_query_plan" ADD CONSTRAINT "discovery_query_plan_icp_id_fkey" FOREIGN KEY ("icp_id") REFERENCES "icp_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Row-Level Security (ADR-001) ──
ALTER TABLE "qualification_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qualification_rule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "qualification_rule_tenant_isolation" ON "qualification_rule"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "icp_backtest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "icp_backtest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "icp_backtest_tenant_isolation" ON "icp_backtest"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "discovery_query_plan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discovery_query_plan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "discovery_query_plan_tenant_isolation" ON "discovery_query_plan"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "qualification_rule", "icp_backtest", "discovery_query_plan" TO app_user;
