-- S1-2：skill_version 支持 service 型技能（service_handler 绑定；task contract 列改可空）。
-- 既有行（model_task）保持不变；CHECK 保证每行恰好一种绑定。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "skill_version" ALTER COLUMN "task_contract_id" DROP NOT NULL;
ALTER TABLE "skill_version" ALTER COLUMN "task_contract_digest" DROP NOT NULL;
ALTER TABLE "skill_version" ADD COLUMN "service_handler" TEXT;

ALTER TABLE "skill_version"
    ADD CONSTRAINT "skill_version_binding_check" CHECK (
        ("service_handler" IS NOT NULL AND "task_contract_id" IS NULL AND "task_contract_digest" IS NULL)
        OR
        ("service_handler" IS NULL AND "task_contract_id" IS NOT NULL AND "task_contract_digest" IS NOT NULL)
    );

COMMIT;
