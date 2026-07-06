/*
  Warnings:

  - You are about to drop the column `organization_id` on the `workspace` table. All the data in the column will be lost.
  - You are about to drop the `membership` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `organization` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('DRAFT', 'ENRICHING', 'ACTIVE');

-- CreateEnum
CREATE TYPE "claim_status" AS ENUM ('INGESTED', 'EXTRACTED', 'NEEDS_REVIEW', 'APPROVED', 'EXPIRED', 'REVOKED');

-- DropForeignKey
ALTER TABLE "membership" DROP CONSTRAINT "membership_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "membership" DROP CONSTRAINT "membership_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "workspace" DROP CONSTRAINT "workspace_organization_id_fkey";

-- DropIndex
DROP INDEX "workspace_organization_id_idx";

-- AlterTable
ALTER TABLE "workspace" DROP COLUMN "organization_id",
ALTER COLUMN "name" DROP NOT NULL;

-- DropTable
DROP TABLE "membership";

-- DropTable
DROP TABLE "organization";

-- DropEnum
DROP TYPE "role";

-- CreateTable
CREATE TABLE "company_profile" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "status" "company_status" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offering" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "attributes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_source" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "uri" TEXT,
    "status" TEXT NOT NULL DEFAULT 'INGESTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "source_id" UUID,
    "type" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "status" "claim_status" NOT NULL DEFAULT 'EXTRACTED',
    "confidence" DOUBLE PRECISION,
    "valid_until" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "source_url" TEXT,
    "snippet" TEXT,
    "confidence" DOUBLE PRECISION,
    "fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citation" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "locator" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_profile_workspace_id_idx" ON "company_profile"("workspace_id");

-- CreateIndex
CREATE INDEX "offering_workspace_id_idx" ON "offering"("workspace_id");

-- CreateIndex
CREATE INDEX "offering_company_id_idx" ON "offering"("company_id");

-- CreateIndex
CREATE INDEX "knowledge_source_workspace_id_idx" ON "knowledge_source"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_source_company_id_idx" ON "knowledge_source"("company_id");

-- CreateIndex
CREATE INDEX "claim_workspace_id_idx" ON "claim"("workspace_id");

-- CreateIndex
CREATE INDEX "claim_company_id_idx" ON "claim"("company_id");

-- CreateIndex
CREATE INDEX "evidence_workspace_id_idx" ON "evidence"("workspace_id");

-- CreateIndex
CREATE INDEX "evidence_claim_id_idx" ON "evidence"("claim_id");

-- CreateIndex
CREATE INDEX "citation_workspace_id_idx" ON "citation"("workspace_id");

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering" ADD CONSTRAINT "offering_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_source" ADD CONSTRAINT "knowledge_source_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citation" ADD CONSTRAINT "citation_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security for company & knowledge tables (ADR-001) ──
-- Pattern: enable + force + USING/WITH CHECK on current_workspace_id().
ALTER TABLE "company_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profile" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_profile_tenant_isolation" ON "company_profile"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "offering" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offering" FORCE ROW LEVEL SECURITY;
CREATE POLICY "offering_tenant_isolation" ON "offering"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "knowledge_source" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_source_tenant_isolation" ON "knowledge_source"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "claim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "claim" FORCE ROW LEVEL SECURITY;
CREATE POLICY "claim_tenant_isolation" ON "claim"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "evidence_tenant_isolation" ON "evidence"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "citation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "citation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "citation_tenant_isolation" ON "citation"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- Explicit grants (default privileges also cover future tables owned by global).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "company_profile", "offering", "knowledge_source", "claim", "evidence", "citation"
  TO app_user;
