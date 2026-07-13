-- CreateTable
CREATE TABLE "patent_inventor_cache" (
    "id" UUID NOT NULL,
    "assignee_name_raw" TEXT NOT NULL,
    "assignee_norm" TEXT NOT NULL,
    "assignee_country" TEXT NOT NULL DEFAULT '',
    "inventor_name" TEXT NOT NULL,
    "window_from_year" INTEGER NOT NULL,
    "window_to_year" INTEGER NOT NULL,
    "license" TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    "refreshed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patent_inventor_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patent_lookup_request" (
    "id" UUID NOT NULL,
    "assignee_norm" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT '',
    "anchor" TEXT NOT NULL,
    "sample_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "first_requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshed_at" TIMESTAMP(3),
    "next_refresh_at" TIMESTAMP(3),

    CONSTRAINT "patent_lookup_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patent_cache_refresh_audit" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "anchor_count" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "bytes_scanned" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "detail" TEXT,

    CONSTRAINT "patent_cache_refresh_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patent_inventor_cache_assignee_norm_idx" ON "patent_inventor_cache"("assignee_norm");

-- CreateIndex
CREATE INDEX "patent_inventor_cache_expires_at_idx" ON "patent_inventor_cache"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "patent_inventor_cache_assignee_norm_assignee_country_invent_key" ON "patent_inventor_cache"("assignee_norm", "assignee_country", "inventor_name");

-- CreateIndex
CREATE INDEX "patent_lookup_request_status_next_refresh_at_idx" ON "patent_lookup_request"("status", "next_refresh_at");

-- CreateIndex
CREATE UNIQUE INDEX "patent_lookup_request_assignee_norm_country_key" ON "patent_lookup_request"("assignee_norm", "country");

-- CreateIndex
CREATE INDEX "patent_cache_refresh_audit_started_at_idx" ON "patent_cache_refresh_audit"("started_at");

-- 平台级共享表（无 RLS，镜像 source_signal）：app_user 全 CRUD（发现读缓存+enqueue；刷新走 owner）。
GRANT SELECT, INSERT, UPDATE, DELETE ON "patent_inventor_cache" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "patent_lookup_request" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "patent_cache_refresh_audit" TO app_user;
