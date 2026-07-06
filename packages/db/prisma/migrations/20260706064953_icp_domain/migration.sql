-- CreateEnum
CREATE TYPE "icp_status" AS ENUM ('DRAFT', 'HYPOTHESIS', 'VALIDATING', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "icp_definition" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "icp_status" NOT NULL DEFAULT 'DRAFT',
    "company_attributes" JSONB,
    "pain_points" JSONB,
    "trigger_signals" JSONB,
    "exclusions" JSONB,
    "value_props" JSONB,
    "target_markets" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "icp_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persona" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "goals" JSONB,
    "pain_points" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buying_committee_role" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "title" TEXT,
    "concerns" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buying_committee_role_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "icp_definition_workspace_id_idx" ON "icp_definition"("workspace_id");

-- CreateIndex
CREATE INDEX "icp_definition_company_id_idx" ON "icp_definition"("company_id");

-- CreateIndex
CREATE INDEX "persona_workspace_id_idx" ON "persona"("workspace_id");

-- CreateIndex
CREATE INDEX "persona_icp_id_idx" ON "persona"("icp_id");

-- CreateIndex
CREATE INDEX "buying_committee_role_workspace_id_idx" ON "buying_committee_role"("workspace_id");

-- CreateIndex
CREATE INDEX "buying_committee_role_icp_id_idx" ON "buying_committee_role"("icp_id");

-- AddForeignKey
ALTER TABLE "icp_definition" ADD CONSTRAINT "icp_definition_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "persona" ADD CONSTRAINT "persona_icp_id_fkey" FOREIGN KEY ("icp_id") REFERENCES "icp_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buying_committee_role" ADD CONSTRAINT "buying_committee_role_icp_id_fkey" FOREIGN KEY ("icp_id") REFERENCES "icp_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security for ICP tables (ADR-001) ──
ALTER TABLE "icp_definition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "icp_definition" FORCE ROW LEVEL SECURITY;
CREATE POLICY "icp_definition_tenant_isolation" ON "icp_definition"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "persona" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "persona" FORCE ROW LEVEL SECURITY;
CREATE POLICY "persona_tenant_isolation" ON "persona"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "buying_committee_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "buying_committee_role" FORCE ROW LEVEL SECURITY;
CREATE POLICY "buying_committee_role_tenant_isolation" ON "buying_committee_role"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "icp_definition", "persona", "buying_committee_role" TO app_user;
