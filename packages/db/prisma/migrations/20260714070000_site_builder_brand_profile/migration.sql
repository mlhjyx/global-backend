-- CreateTable
CREATE TABLE "brand_profile" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "value_props" JSONB,
    "tone" JSONB,
    "glossary" JSONB,
    "keywords" JSONB,
    "differentiators" JSONB,
    "competitors" JSONB,
    "fact_sheet" JSONB,
    "gaps" JSONB,
    "research_degraded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brand_profile_workspace_id_idx" ON "brand_profile"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_profile_site_id_version_key" ON "brand_profile"("site_id", "version");

-- AddForeignKey
ALTER TABLE "brand_profile" ADD CONSTRAINT "brand_profile_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS（分租户硬隔离，镜像 site_builder_foundation + force_rls 先例）
ALTER TABLE "brand_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_profile" FORCE ROW LEVEL SECURITY;
CREATE POLICY "brand_profile_tenant_isolation" ON "brand_profile"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- app_user 权限（RLS 之上仍需表权限）
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_profile" TO app_user;
