-- P1-10（联系人工程）：扩展执行预算 purpose 枚举 contact.enrich（富集端点/run activity 用）。
-- 该 purpose 由引擎的 enrich-contacts 端点与 run 内富集 activity 消费（subject_type company）；
-- PostgreSQL 不允许同一事务内使用刚新增的枚举值，故本阶段只加值，
-- 约束与函数的适配在 20261109190100 完成（与 outreach.draft / campaign.plan 同模式）。
-- Forward-only：enum 值不可删除，回滚 = 后续迁移还原约束/函数定义。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TYPE "execution_budget_purpose"
  ADD VALUE IF NOT EXISTS 'contact.enrich' AFTER 'contact.verify';

COMMIT;
