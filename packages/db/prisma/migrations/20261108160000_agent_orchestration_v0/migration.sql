-- M2 步 9b 多 agent 编排 v0（设计：docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md，APPROVED）
-- Additive：agent 注册表 + 决策轨迹两张新表；无回填、不改现有表。
--   * agent_profile：平台级 agent 注册表（角色提示词版本 + 技能子集 + 模型策略 + 记忆作用域 +
--     loop 策略）。平台目录行对所有 workspace 可读；app_user 只允许列级 UPDATE 状态列
--     （ops kill switch），seed 由 owner 连接幂等写入。
--   * agent_decision_trace：append-only 决策轨迹（F2 字段组子集、无 PII：证据只存 URL/时间/
--     支持关系，被否候选只存公司引用 id）。按 workspace 隔离（FORCE RLS）；app_user 仅
--     SELECT/INSERT，无 UPDATE/DELETE 路径；同一 (workspace, run, step_type, discriminator)
--     唯一键幂等（活动重试不翻行）。随 run 级联删除（ON DELETE CASCADE）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "agent_profile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "agent_key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role_prompt_version" TEXT NOT NULL,
  "skill_keys" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "model_policy" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "memory_scope" TEXT NOT NULL DEFAULT 'run',
  "loop_policy" JSONB NOT NULL DEFAULT '{"maxRounds": 1}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "status_reason" VARCHAR(500),
  "status_updated_at" TIMESTAMP(3),
  "status_updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_profile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_profile_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "agent_profile_skill_keys_check" CHECK (jsonb_typeof("skill_keys") = 'array'),
  CONSTRAINT "agent_profile_model_policy_check" CHECK (jsonb_typeof("model_policy") = 'object'),
  CONSTRAINT "agent_profile_loop_policy_check" CHECK (jsonb_typeof("loop_policy") = 'object')
);

CREATE UNIQUE INDEX "agent_profile_agent_key_key" ON "agent_profile" ("agent_key");

-- 平台目录：所有 workspace 上下文可读；写路径只有 owner seed 与 app_user 的状态列 UPDATE
-- （列权限在下面收回/重授），没有 workspace 维度。
ALTER TABLE "agent_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_profile" FORCE ROW LEVEL SECURITY;
CREATE POLICY "agent_profile_platform_visibility" ON "agent_profile"
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE "agent_profile" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "agent_profile" FROM app_user;
GRANT SELECT ON TABLE "agent_profile" TO app_user;
GRANT UPDATE ("status", "status_reason", "status_updated_at", "status_updated_by", "updated_at")
  ON TABLE "agent_profile" TO app_user;

CREATE TABLE "agent_decision_trace" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "workflow_id" TEXT,
  "parent_trace_id" UUID,
  "step_type" TEXT NOT NULL,
  "agent_key" TEXT NOT NULL,
  "actor_type" TEXT NOT NULL DEFAULT 'agent',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "decision_type" TEXT NOT NULL,
  "discriminator" TEXT NOT NULL,
  "chosen_option" JSONB,
  "score" DOUBLE PRECISION,
  "reason_code" TEXT,
  "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "rejected_candidates" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "cost_estimated_micros" BIGINT,
  "cost_actual_micros" BIGINT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_decision_trace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_decision_trace_actor_type_check" CHECK ("actor_type" = 'agent'),
  CONSTRAINT "agent_decision_trace_attempt_check" CHECK ("attempt" >= 1),
  CONSTRAINT "agent_decision_trace_evidence_check" CHECK (jsonb_typeof("evidence") = 'array'),
  CONSTRAINT "agent_decision_trace_rejected_candidates_check" CHECK (jsonb_typeof("rejected_candidates") = 'array'),
  CONSTRAINT "agent_decision_trace_run_fkey" FOREIGN KEY ("workspace_id", "run_id")
    REFERENCES "discovery_run"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "agent_decision_trace_replay_key" UNIQUE ("workspace_id", "run_id", "step_type", "discriminator")
);

CREATE INDEX "agent_decision_trace_run_lookup_idx"
  ON "agent_decision_trace" ("workspace_id", "run_id", "created_at", "id");

ALTER TABLE "agent_decision_trace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_decision_trace" FORCE ROW LEVEL SECURITY;
CREATE POLICY "agent_decision_trace_tenant_isolation" ON "agent_decision_trace"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- append-only：只有 SELECT + INSERT（无 UPDATE/DELETE）。
REVOKE ALL ON TABLE "agent_decision_trace" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "agent_decision_trace" FROM app_user;
GRANT SELECT, INSERT ON TABLE "agent_decision_trace" TO app_user;

COMMIT;
