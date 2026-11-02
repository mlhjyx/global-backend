-- Phase 1（D16 卖家事实 SoR）：注册引导的结构化字段落到 CompanyProfile；
-- Offering 增加数据来源列（onboarding | understanding | manual）。
-- 公司级字段，不涉及个人数据路径；app_user 现有表级权限沿用（列级无需新增授权）。

ALTER TABLE "company_profile"
  ADD COLUMN "target_markets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "business_email" TEXT;

ALTER TABLE "offering"
  ADD COLUMN "source" TEXT;
