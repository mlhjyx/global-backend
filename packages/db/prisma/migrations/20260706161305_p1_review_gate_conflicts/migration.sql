-- AlterEnum
ALTER TYPE "company_status" ADD VALUE 'REVIEW';

-- AlterTable
ALTER TABLE "company_profile" ADD COLUMN     "industry" TEXT,
ADD COLUMN     "summary" TEXT;

-- CreateTable
CREATE TABLE "knowledge_conflict" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "claim_a_id" UUID NOT NULL,
    "claim_b_id" UUID NOT NULL,
    "claim_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolved_by" TEXT,
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "knowledge_conflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_conflict_workspace_id_idx" ON "knowledge_conflict"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_conflict_company_id_idx" ON "knowledge_conflict"("company_id");


-- ── Row-Level Security (ADR-001) ──
ALTER TABLE "knowledge_conflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_conflict" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_conflict_tenant_isolation" ON "knowledge_conflict"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_conflict" TO app_user;
