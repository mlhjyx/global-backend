-- 公司档案软删除（2026-11-03）：卖家可删除自己的 DRAFT 档案；行保留、列表/详情过滤。
-- 物理删除仍归 owner/DSR（与 seller_document 同口径）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "company_profile" ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

CREATE INDEX "company_profile_workspace_id_deleted_at_idx"
    ON "company_profile" ("workspace_id", "deleted_at");

COMMIT;
