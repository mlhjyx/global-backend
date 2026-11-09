-- P1-18（社媒信号，2026-11-10）：company_signal —— changedetection 页面变更 + RSSHub 条目归因到公司。
--
-- 背景：产品负责人批准的免费社媒信号栈（changedetection.io @ 127.0.0.1:5055、RSSHub @
-- 127.0.0.1:1200，RUNBOOK §16）只做公开页面/信息源采集，不做任何平台写操作自动化。
-- 本表是引擎侧落点：apps/api/scripts/signals/ingest-signals.mts 一次拉取 → 解析
-- （RSS2/Atom/changedetection watches）→ 指纹去重 → hostname ↔ canonical_company.domain
-- 归因 → 入库。纯元数据（标题/URL/摘要），不落页面正文。
--
-- 幂等：唯一 (workspace_id, ingest_key)；ingest_key = '<provider>:<sha256>'，
-- sha256(provider|source_url|title|observed_at 秒)。重跑同批 → skipDuplicates 静默跳过。
-- company_id 可空：未归因信号照样落库（不丢数据，留待规则/人工归因）；公司删除 → SET NULL，
-- 信号作为历史事实保留（不随公司级联删除）。
--
-- 租户隔离：ENABLE + FORCE RLS + current_workspace_id() 策略；app_user SELECT/INSERT/UPDATE。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "company_signal" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "company_id" UUID,
  "provider_key" TEXT NOT NULL,
  "signal_kind" TEXT NOT NULL,
  "source_url" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "excerpt" TEXT,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "ingest_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "company_signal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_signal_signal_kind_check" CHECK ("signal_kind" IN ('rss_item', 'page_change')),
  CONSTRAINT "company_signal_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  -- ON UPDATE CASCADE 与 Prisma relation 的默认 onUpdate 动作一致（漂移门零容忍）。
  CONSTRAINT "company_signal_company_id_fkey" FOREIGN KEY ("company_id")
    REFERENCES "canonical_company"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "company_signal_workspace_id_ingest_key_key" UNIQUE ("workspace_id", "ingest_key")
);

CREATE INDEX "company_signal_workspace_id_company_id_observed_at_idx" ON "company_signal"
  ("workspace_id", "company_id", "observed_at" DESC);

ALTER TABLE "company_signal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_signal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_signal_tenant_isolation" ON "company_signal"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "company_signal" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE "company_signal" TO app_user;

COMMIT;
