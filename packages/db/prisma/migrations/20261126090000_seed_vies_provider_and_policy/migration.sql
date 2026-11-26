-- Batch 1.7B-1: 幂等播种欧盟官方免费 VIES 税号核验 provider 与 ec.europa.eu 合规源策略。
-- 仅新增两行平台配置（ON CONFLICT DO NOTHING），不覆写运维已手工调整的状态或保留期。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO "data_provider" ("id", "key", "class", "status", "cost_per_call_cents")
VALUES (gen_random_uuid(), 'vies', 'company_registry', 'ENABLED', 0)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "source_policy" (
  "id",
  "domain",
  "source_type",
  "access_mode",
  "robots_status",
  "terms_status",
  "personal_data",
  "allowed_purpose",
  "retention_days",
  "review_status",
  "notes",
  "updated_at"
)
VALUES (
  gen_random_uuid(),
  'ec.europa.eu',
  'gov_registry',
  'api',
  'ALLOWS',
  'REVIEWED_OK',
  false,
  '["discovery", "enrichment"]'::jsonb,
  365,
  'APPROVED',
  'EU VIES VAT 公开 REST API（Commission Reuse Notice 2011/833/EU）。vies.check 工具治理域；仅核验法人 VAT 身份，回执与入库均剥离原始街道地址。',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("domain") DO NOTHING;

COMMIT;
