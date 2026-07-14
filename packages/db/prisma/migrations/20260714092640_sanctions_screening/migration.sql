-- CreateTable
CREATE TABLE "sanctions_source" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISABLED',
    "publish_date" TIMESTAMP(3),
    "record_count" INTEGER,
    "last_refreshed_at" TIMESTAMP(3),
    "last_fetch_status" TEXT,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sanctions_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sanctions_entity" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "primary_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "country" TEXT,
    "programs" JSONB NOT NULL,
    "aliases" JSONB NOT NULL,
    "raw_features" JSONB,
    "list_version" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sanctions_entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sanctions_screening_result" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "canonical_company_id" UUID NOT NULL,
    "screened_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "matches" JSONB NOT NULL,
    "top_score" DOUBLE PRECISION,
    "review_state" TEXT NOT NULL DEFAULT 'open',
    "reviewed_by" TEXT,
    "review_note" TEXT,
    "list_versions" JSONB NOT NULL,
    "screened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sanctions_screening_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sanctions_source_key_key" ON "sanctions_source"("key");

-- CreateIndex
CREATE INDEX "sanctions_entity_normalized_name_idx" ON "sanctions_entity"("normalized_name");

-- CreateIndex
CREATE INDEX "sanctions_entity_source_id_withdrawn_at_idx" ON "sanctions_entity"("source_id", "withdrawn_at");

-- CreateIndex
CREATE UNIQUE INDEX "sanctions_entity_source_id_external_id_key" ON "sanctions_entity"("source_id", "external_id");

-- CreateIndex
CREATE INDEX "sanctions_screening_result_workspace_id_canonical_company_i_idx" ON "sanctions_screening_result"("workspace_id", "canonical_company_id");

-- CreateIndex
CREATE INDEX "sanctions_screening_result_workspace_id_review_state_idx" ON "sanctions_screening_result"("workspace_id", "review_state");

-- AddForeignKey
ALTER TABLE "sanctions_entity" ADD CONSTRAINT "sanctions_entity_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sanctions_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── RLS / 权限（制裁筛查，Prisma 不建模 RLS，手工追加）─────────────────────────
-- sanctions_source / sanctions_entity：平台级参考数据（无 RLS，同 canonical_taxonomy 惯例）。
-- owner 连接写（刷新/seed），app_user 只读筛查 → GRANT SELECT（最小权限）。
GRANT SELECT ON "sanctions_source" TO app_user;
GRANT SELECT ON "sanctions_entity" TO app_user;

-- sanctions_screening_result：租户级筛查结果，RLS 硬隔离（镜像既有租户表 brand_profile 先例）。
ALTER TABLE "sanctions_screening_result" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sanctions_screening_result" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sanctions_screening_result_tenant_isolation" ON "sanctions_screening_result"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "sanctions_screening_result" TO app_user;
