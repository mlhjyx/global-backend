-- AlterTable
ALTER TABLE "patent_inventor_cache" ADD COLUMN     "inventor_name_key" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "patent_inventor_cache_inventor_name_key_idx" ON "patent_inventor_cache"("inventor_name_key");
