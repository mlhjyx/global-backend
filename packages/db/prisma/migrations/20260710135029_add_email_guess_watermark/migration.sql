-- AlterTable
ALTER TABLE "canonical_company" ADD COLUMN     "email_guess_attempted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_email_guess_attempted_at_idx" ON "canonical_company"("workspace_id", "email_guess_attempted_at");
