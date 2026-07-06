-- AlterTable
ALTER TABLE "raw_source_record" ADD COLUMN     "content_hash" TEXT,
ADD COLUMN     "fetched_at" TIMESTAMP(3),
ADD COLUMN     "parser_version" TEXT,
ADD COLUMN     "source_url" TEXT;

-- CreateTable
CREATE TABLE "source_policy" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "access_mode" TEXT NOT NULL DEFAULT 'crawl',
    "allowed_paths" JSONB,
    "disallowed_paths" JSONB,
    "robots_status" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "terms_status" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "personal_data" BOOLEAN NOT NULL DEFAULT false,
    "allowed_purpose" JSONB,
    "crawl_delay_ms" INTEGER NOT NULL DEFAULT 2000,
    "retention_days" INTEGER NOT NULL DEFAULT 365,
    "review_status" TEXT NOT NULL DEFAULT 'APPROVED',
    "owner" TEXT NOT NULL DEFAULT 'backend',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_policy_domain_key" ON "source_policy"("domain");


-- source_policy 是平台治理表（无租户数据）：app_user 只读，写由 owner/运营通道执行
GRANT SELECT ON "source_policy" TO app_user;
