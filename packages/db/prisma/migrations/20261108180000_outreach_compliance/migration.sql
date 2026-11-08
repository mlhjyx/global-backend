-- M2 步 11-1 合规底座（设计：docs/superpowers/plans/2026-11-08-controlled-email-outreach-m2-step11.md，APPROVED）
-- 平台级外联全局抑制：跨租户退订/投诉/退信，只存规范化邮箱的 SHA-256（无明文 PII）。
-- Additive，无回填；无 RLS（平台表，app_user 只授 SELECT/INSERT，抑制事实 append-only）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "outreach_global_suppression" (
  "id" UUID NOT NULL,
  "email_hash" CHAR(64) NOT NULL,
  "reason" VARCHAR(32) NOT NULL,
  "source" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "outreach_global_suppression_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_global_suppression_hash_check" CHECK ("email_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "outreach_global_suppression_reason_check" CHECK ("reason" IN ('unsubscribe', 'bounce', 'complaint', 'manual', 'legal')),
  CONSTRAINT "outreach_global_suppression_source_check" CHECK (char_length("source") BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX "outreach_global_suppression_email_hash_key"
  ON "outreach_global_suppression"("email_hash");

GRANT SELECT, INSERT ON TABLE "outreach_global_suppression" TO app_user;

COMMIT;
