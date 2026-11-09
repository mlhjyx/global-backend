-- 注册即建档第 1 步（2026-11-10）：档案保存受控行业码。
-- industry 列继续存展示标签（旧界面/上游 NACE 词面映射读取它），新列存
-- canonical_taxonomy(kind='industry') 的 ISIC code；两列由建档与 onboarding-facts
-- 路径同事务写入。可空、无回填：既有自由文本行业保持原样。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "company_profile"
  ADD COLUMN "industry_code" TEXT;

COMMIT;
