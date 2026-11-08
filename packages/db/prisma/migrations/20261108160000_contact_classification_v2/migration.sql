-- A4（2026-11-08）：联系方式分类器 v2 的 schema 扩展。
--
-- 1) contact_point 增分类/来源/合规/验证元数据（全部 nullable，历史行不受影响）：
--    email_type（这是什么邮箱）、source_type/source_url（从哪来）、robots_status/tos_status
--    （抓取合规留痕）、legal_basis（GDPR 依据）、verification_method/catch_all（怎么验的）、
--    consent_record（A6 发送门用）。
-- 2) 新表 company_contact_channel：公司级联系方式层——Impressum 法定公开的 role 邮箱与总机
--    电话是公司事实（email=amber 职能邮箱 / phone、form_url=green），与只存 URL 的
--    company_contact_point 分工：那张表保持无邮箱/电话的绿地不变量。
BEGIN;

ALTER TABLE "contact_point"
  ADD COLUMN "email_type" TEXT,
  ADD COLUMN "source_type" TEXT,
  ADD COLUMN "source_url" TEXT,
  ADD COLUMN "robots_status" TEXT,
  ADD COLUMN "tos_status" TEXT,
  ADD COLUMN "legal_basis" TEXT,
  ADD COLUMN "verification_method" TEXT,
  ADD COLUMN "catch_all" TEXT,
  ADD COLUMN "consent_record" JSONB;

ALTER TABLE "contact_point"
  ADD CONSTRAINT "contact_point_email_type_check" CHECK (
    "email_type" IS NULL OR "email_type" IN
      ('role', 'generic_sales', 'procurement', 'management', 'finance', 'support', 'personal', 'other')
  ),
  ADD CONSTRAINT "contact_point_source_type_check" CHECK (
    "source_type" IS NULL OR "source_type" IN
      ('impressum', 'contact_page', 'homepage', 'directory', 'social', 'pattern_guess', 'operator', 'provider')
  ),
  ADD CONSTRAINT "contact_point_source_url_check" CHECK (
    "source_url" IS NULL OR (
      char_length("source_url") BETWEEN 8 AND 2048
      AND "source_url" LIKE 'https://%'
      AND "source_url" !~ '[[:space:]]'
    )
  ),
  ADD CONSTRAINT "contact_point_robots_status_check" CHECK (
    "robots_status" IS NULL OR "robots_status" IN ('allowed', 'disallowed', 'unknown')
  ),
  ADD CONSTRAINT "contact_point_tos_status_check" CHECK (
    "tos_status" IS NULL OR "tos_status" IN ('allowed', 'restricted', 'unknown')
  ),
  ADD CONSTRAINT "contact_point_legal_basis_check" CHECK (
    "legal_basis" IS NULL OR "legal_basis" IN
      ('legitimate_interest', 'consent', 'contract', 'legal_obligation')
  ),
  ADD CONSTRAINT "contact_point_verification_method_check" CHECK (
    "verification_method" IS NULL OR "verification_method" IN
      ('smtp_rcpt', 'pattern_guess', 'provider_reported', 'operator', 'import')
  ),
  ADD CONSTRAINT "contact_point_catch_all_check" CHECK (
    "catch_all" IS NULL OR "catch_all" IN ('catch_all', 'not_catch_all', 'inconclusive', 'unknown')
  ),
  ADD CONSTRAINT "contact_point_consent_record_check" CHECK (
    "consent_record" IS NULL
    OR (jsonb_typeof("consent_record") = 'object' AND octet_length("consent_record"::text) <= 8192)
  );

-- 注意：这里**不**强制「personal ⇒ legal_basis 非空」——allowPersonalWithoutBasis 是已批准的
-- 逃生门（结果会 personal_data=true 而 lawful_basis=null），DB 不得与该产品决定冲突；
-- 依据纪律由写入方与合规门（A6）在应用层执行。

CREATE TABLE "company_contact_channel" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "email_type" TEXT,
  "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "data_class" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_url" TEXT,
  "robots_status" TEXT,
  "tos_status" TEXT,
  "legal_basis" TEXT,
  "verification_method" TEXT,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "updated_by" TEXT,

  CONSTRAINT "company_contact_channel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_contact_channel_channel_check" CHECK ("channel" IN ('email', 'phone', 'form_url')),
  -- email=职能邮箱（amber，email_type 必填且不得 personal——具名人邮箱只属于联系人层）；
  -- phone/form_url=公司事实（green，email_type 必须为空）。
  CONSTRAINT "company_contact_channel_class_check" CHECK (
    ("channel" = 'email' AND "data_class" = 'amber' AND "email_type" IS NOT NULL
      AND "email_type" IN ('role', 'generic_sales', 'procurement', 'management', 'finance', 'support', 'other'))
    OR ("channel" IN ('phone', 'form_url') AND "data_class" = 'green' AND "email_type" IS NULL)
  ),
  CONSTRAINT "company_contact_channel_value_check" CHECK (
    char_length("value") BETWEEN 5 AND 512
    AND CASE "channel"
      WHEN 'email' THEN "value" ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
      -- 电话允许空格/括号/斜杠（+49 89 1234567 是合法公司总机；写入器已归一为单空格）。
      WHEN 'phone' THEN "value" ~ '^\+?[0-9()/ -]{5,32}$'
      -- 表单 URL 不含空白/查询串/锚点（只收干净的联系页地址）。
      WHEN 'form_url' THEN "value" LIKE 'https://%' AND strpos("value", '?') = 0
        AND strpos("value", '#') = 0 AND "value" !~ '[[:space:]]'
    END
  ),
  CONSTRAINT "company_contact_channel_status_check" CHECK ("status" IN ('UNVERIFIED', 'VALID', 'RISKY', 'INVALID')),
  -- VALID 只能由人确认（与 company_contact_point 同纪律）：人工标记必须留下 updated_by。
  CONSTRAINT "company_contact_channel_status_marker_check" CHECK ("status" <> 'VALID' OR "updated_by" IS NOT NULL),
  CONSTRAINT "company_contact_channel_source_check" CHECK ("source_type" IN ('impressum', 'contact_page', 'homepage', 'operator')),
  CONSTRAINT "company_contact_channel_source_url_check" CHECK (
    "source_url" IS NULL OR (char_length("source_url") BETWEEN 8 AND 2048
      AND "source_url" LIKE 'https://%' AND "source_url" !~ '[[:space:]]')
  ),
  CONSTRAINT "company_contact_channel_robots_check" CHECK (
    "robots_status" IS NULL OR "robots_status" IN ('allowed', 'disallowed', 'unknown')
  ),
  CONSTRAINT "company_contact_channel_tos_check" CHECK (
    "tos_status" IS NULL OR "tos_status" IN ('allowed', 'restricted', 'unknown')
  ),
  CONSTRAINT "company_contact_channel_legal_basis_check" CHECK (
    "legal_basis" IS NULL OR "legal_basis" IN ('legitimate_interest', 'consent', 'contract', 'legal_obligation')
  ),
  CONSTRAINT "company_contact_channel_verification_check" CHECK (
    "verification_method" IS NULL OR "verification_method" IN ('smtp_rcpt', 'pattern_guess', 'provider_reported', 'operator', 'import')
  ),
  CONSTRAINT "company_contact_channel_updated_by_check" CHECK ("updated_by" IS NULL OR char_length("updated_by") BETWEEN 1 AND 256),
  CONSTRAINT "company_contact_channel_seen_check" CHECK ("first_seen_at" <= "last_seen_at"),
  CONSTRAINT "company_contact_channel_company_fkey" FOREIGN KEY ("workspace_id", "company_id")
    REFERENCES "canonical_company"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "company_contact_channel_identity_key"
  ON "company_contact_channel"("workspace_id", "company_id", "channel", "value");

ALTER TABLE "company_contact_channel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_contact_channel" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_contact_channel_tenant_isolation" ON "company_contact_channel"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "company_contact_channel" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "company_contact_channel" TO app_user;

COMMIT;
