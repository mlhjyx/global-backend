-- AlterTable
ALTER TABLE "canonical_company" ADD COLUMN     "contact_discovery_attempted_at" TIMESTAMP(3),
ADD COLUMN     "last_enriched_at" TIMESTAMP(3),
ADD COLUMN     "last_signal_at" TIMESTAMP(3),
ADD COLUMN     "last_watch_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_fit_verdict_last_enriched_at_idx" ON "canonical_company"("workspace_id", "fit_verdict", "last_enriched_at");

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_fit_verdict_last_signal_at_idx" ON "canonical_company"("workspace_id", "fit_verdict", "last_signal_at");

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_fit_verdict_last_watch_at_idx" ON "canonical_company"("workspace_id", "fit_verdict", "last_watch_at");

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_fit_verdict_contact_discover_idx" ON "canonical_company"("workspace_id", "fit_verdict", "contact_discovery_attempted_at");
