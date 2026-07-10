/*
  Warnings:

  - You are about to drop the column `fit_reasons` on the `canonical_company` table. All the data in the column will be lost.
  - You are about to drop the column `fit_verdict` on the `canonical_company` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "canonical_company_workspace_id_fit_verdict_contact_discover_idx";

-- DropIndex
DROP INDEX "canonical_company_workspace_id_fit_verdict_last_enriched_at_idx";

-- DropIndex
DROP INDEX "canonical_company_workspace_id_fit_verdict_last_signal_at_idx";

-- DropIndex
DROP INDEX "canonical_company_workspace_id_fit_verdict_last_watch_at_idx";

-- AlterTable
ALTER TABLE "canonical_company" DROP COLUMN "fit_reasons",
DROP COLUMN "fit_verdict";

-- AlterTable
ALTER TABLE "lead" ADD COLUMN     "fit_reasons" JSONB,
ADD COLUMN     "fit_verdict" TEXT;

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_last_enriched_at_idx" ON "canonical_company"("workspace_id", "last_enriched_at");

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_last_signal_at_idx" ON "canonical_company"("workspace_id", "last_signal_at");

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_last_watch_at_idx" ON "canonical_company"("workspace_id", "last_watch_at");

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_contact_discovery_attempted__idx" ON "canonical_company"("workspace_id", "contact_discovery_attempted_at");

-- CreateIndex
CREATE INDEX "lead_workspace_id_icp_id_fit_verdict_idx" ON "lead"("workspace_id", "icp_id", "fit_verdict");

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_canonical_company_id_fkey" FOREIGN KEY ("canonical_company_id") REFERENCES "canonical_company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
