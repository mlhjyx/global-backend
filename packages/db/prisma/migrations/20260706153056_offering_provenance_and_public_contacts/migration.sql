-- AlterTable
ALTER TABLE "company_profile" ADD COLUMN     "public_contacts" JSONB;

-- AlterTable
ALTER TABLE "offering" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "evidence" TEXT,
ADD COLUMN     "source_url" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "offering_company_id_name_key" ON "offering"("company_id", "name");

