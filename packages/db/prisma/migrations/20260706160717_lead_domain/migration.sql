-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('DISCOVERED', 'ENRICHING', 'REVIEW', 'QUALIFIED', 'REJECTED', 'SUPPRESSED', 'CONTACTED', 'CONVERTED');

-- CreateTable
CREATE TABLE "lead" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "canonical_company_id" UUID NOT NULL,
    "status" "lead_status" NOT NULL DEFAULT 'DISCOVERED',
    "queue" TEXT NOT NULL DEFAULT 'needs_review',
    "total_score" DOUBLE PRECISION,
    "scores" JSONB,
    "score_detail" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_decision" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "decided_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_workspace_id_idx" ON "lead"("workspace_id");

-- CreateIndex
CREATE INDEX "lead_workspace_id_queue_idx" ON "lead"("workspace_id", "queue");

-- CreateIndex
CREATE UNIQUE INDEX "lead_workspace_id_icp_id_canonical_company_id_key" ON "lead"("workspace_id", "icp_id", "canonical_company_id");

-- CreateIndex
CREATE INDEX "lead_decision_workspace_id_idx" ON "lead_decision"("workspace_id");

-- CreateIndex
CREATE INDEX "lead_decision_lead_id_idx" ON "lead_decision"("lead_id");

-- AddForeignKey
ALTER TABLE "lead_decision" ADD CONSTRAINT "lead_decision_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Row-Level Security (ADR-001) ──
ALTER TABLE "lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_tenant_isolation" ON "lead"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "lead_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_decision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_decision_tenant_isolation" ON "lead_decision"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "lead", "lead_decision" TO app_user;
