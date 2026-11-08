-- M2.1（campaign.plan first phase）：扩展执行预算 purpose 枚举。
-- 该 purpose 由引擎受限 Campaign 规划器的内部 draft 端点消费（subject_type campaign）；
-- PostgreSQL 不允许同一事务内使用刚新增的枚举值，故本阶段只加值，
-- 约束与函数的适配在 20261108163100 完成（与 outreach.draft / platform.channel_crawl 同模式）。
-- Forward-only：enum 值不可删除，回滚 = 后续迁移还原约束/函数定义。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TYPE "execution_budget_purpose"
  ADD VALUE IF NOT EXISTS 'campaign.plan' AFTER 'outreach.draft';

COMMIT;
