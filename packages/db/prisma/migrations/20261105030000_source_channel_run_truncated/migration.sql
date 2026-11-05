-- P4-P4c: 记 BUDGET_TRUNCATED —— 日配额/单轮上限把本轮页数截断时为 true。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "source_channel_run"
  ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
