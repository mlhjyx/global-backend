-- CH-7（GainOS v3.0 第 6 章 §6.3.2 migration 5 / CP-G8）：渠道记录观察名单。
--   新观测默认 review_status=PENDING（观察名单）；人工抽检置 APPROVED/REJECTED 并留审计足迹。
--   materialized_company_id 是「并入正式池」后的公司引用位（跨租户口径未定时只留列，不建外键）。
-- Additive；存量 48 行保持默认 PENDING（从未做过人工抽检，不伪造 APPROVED）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "source_channel_record"
  ADD COLUMN "review_status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "reviewed_by" VARCHAR(200),
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(3),
  ADD COLUMN "materialized_company_id" UUID;

ALTER TABLE "source_channel_record"
  ADD CONSTRAINT "source_channel_record_review_status_check"
    CHECK ("review_status" IN ('PENDING', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT "source_channel_record_review_audit_check" CHECK (
    ("review_status" = 'PENDING' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL)
    OR ("review_status" IN ('APPROVED', 'REJECTED') AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  );

-- 索引名按 Prisma datamodel 默认（@@index([channelId, reviewStatus]) → _channel_id_review_status_idx）。
CREATE INDEX "source_channel_record_channel_id_review_status_idx"
  ON "source_channel_record" ("channel_id", "review_status");

COMMIT;
