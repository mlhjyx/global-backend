-- 渠道抓取记录物化（2026-11-05 设计；OWNER-DECISION-2026-11-05）：
--   * source_channel_record：平台级抓取记录池。公司级字段 + 联系人字段（PII_PENDING_ENCRYPTION——
--     明文存储；加密受限存储、Q25 访问审计、保留期按产品负责人决定延后到后续任务）。
--     按 (channel_id, dedupe_key) 跨轮 upsert；按 crawl_run_id 归轮次可溯源。
--   * source_channel_run.crawl_run_id：工作流稳定标识，finalize 以唯一约束幂等。
-- Additive, no backfill。平台表无 RLS（无租户列，与 source_channel/source_channel_run 同层惯例；
-- 读接口仅 ops:read），写入经 app_user GRANT 与引擎代码路径把关。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "source_channel_record" (
  "id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "crawl_run_id" UUID NOT NULL,
  "dedupe_key" VARCHAR(200) NOT NULL,
  "name" VARCHAR(300) NOT NULL,
  "website" VARCHAR(2048),
  "country" VARCHAR(100),
  "industry" VARCHAR(200),
  "products" JSONB,
  "keywords" JSONB,
  "contact_name" VARCHAR(200),
  "contact_title" VARCHAR(200),
  "email" VARCHAR(320),
  "phone" VARCHAR(64),
  "source_url" VARCHAR(2048) NOT NULL,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "content_hash" VARCHAR(64),

  CONSTRAINT "source_channel_record_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_channel_record_channel_fkey" FOREIGN KEY ("channel_id")
    REFERENCES "source_channel"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "source_channel_record_name_check" CHECK (char_length("name") BETWEEN 1 AND 300),
  CONSTRAINT "source_channel_record_dedupe_check" CHECK (char_length("dedupe_key") BETWEEN 1 AND 200),
  CONSTRAINT "source_channel_record_source_url_check" CHECK ("source_url" LIKE 'https://%')
);

CREATE UNIQUE INDEX "source_channel_record_channel_dedupe_key"
  ON "source_channel_record"("channel_id", "dedupe_key");

CREATE INDEX "source_channel_record_channel_last_seen_idx"
  ON "source_channel_record"("channel_id", "last_seen_at" DESC);

ALTER TABLE "source_channel_run"
  ADD COLUMN "crawl_run_id" UUID;

CREATE UNIQUE INDEX "source_channel_run_crawl_run_key"
  ON "source_channel_run"("crawl_run_id");

GRANT SELECT, INSERT, UPDATE ON TABLE "source_channel_record" TO app_user;

COMMIT;
