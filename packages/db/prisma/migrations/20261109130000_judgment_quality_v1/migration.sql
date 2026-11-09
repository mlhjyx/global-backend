-- P3（ch04 判定质量）J04：判定质量六表。
--
-- 设计依据：《GainOS 深化计划 v3.0》第 4 章 §4.3.2.8（hard_gate_result / gate_enrichment_task）、
-- §4.3.4.2（judgment_record）、§4.3.7.3（conformal_threshold）、§4.3.8.1（judgment_review_task）、
-- §4.3.8.3（judgment_golden_label）；Prisma datamodel 同步于 packages/db/prisma/schema.prisma。
--
-- 权限语义（与 docs/governance/app-user-table-privileges.json 对账）：
--  * append-only（hard_gate_result / judgment_record / judgment_golden_label）：
--    app_user 仅 SELECT, INSERT —— 判定历史不可改写，参照 agent_decision_trace 的既有做法；
--  * 有状态机（gate_enrichment_task / judgment_review_task）：app_user SELECT, INSERT, UPDATE，
--    DELETE 拒绝（状态机只前进：queued → running/in_review → filled/resolved/expired）；
--  * conformal_threshold 是全局阈值工件（无 workspace_id）：不开 RLS，app_user 仅 SELECT，
--    写入只允许 owner 的拟合任务。
--
-- Prisma 不可建模索引：hard_gate_result_replay_key / gate_enrichment_task_key
-- （COALESCE(icp_id) 表达式唯一索引）、conformal_threshold_active_key /
-- judgment_record_failure_idx（部分索引）。2026-11-09 实测 Prisma 6.1 的 migrate diff
-- 对部分索引与表达式索引整体忽略（普通多余索引仍报 DROP INDEX），故这四条既不能进
-- datamodel，也无需登记 packages/db/prisma/drift-baseline.json（登记反而触发 ratchet 的
-- STALE 判定）。漂移门对这些索引的静默由本节说明与迁移评审兜底。
--
-- FK 修正（设计评审已定）：judgment_record 对 discovery_run 的设计稿复合 FK
-- ("workspace_id","run_id") REFERENCES "discovery_run"("workspace_id","id") ON DELETE SET NULL
-- 不可实现——SET NULL 需要把参与 FK 的列都置 NULL，而 workspace_id 是 NOT NULL；
-- 改为单列 FK "run_id" → "discovery_run"("id") ON DELETE SET NULL，
-- workspace 归属由应用层（withWorkspace 事务）校验。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ① 硬门结果（append-only）：一次评估一行，replay 唯一键幂等。
CREATE TABLE "hard_gate_result" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "canonical_company_id" UUID NOT NULL,
  "icp_id" UUID,
  "gate_set_version" TEXT NOT NULL,
  "gate_id" TEXT NOT NULL,
  "gate_version" TEXT NOT NULL,
  "verdict" TEXT NOT NULL,
  "reason_code" TEXT,
  "applicable" BOOLEAN NOT NULL DEFAULT true,
  "facts" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "input_digest" CHAR(64) NOT NULL,
  "evaluated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "hard_gate_result_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hard_gate_result_verdict_check"
    CHECK ("verdict" IN ('PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE')),
  CONSTRAINT "hard_gate_result_digest_check" CHECK ("input_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hard_gate_result_facts_check" CHECK (jsonb_typeof("facts") = 'object')
);
CREATE UNIQUE INDEX "hard_gate_result_replay_key"
  ON "hard_gate_result" ("workspace_id", "canonical_company_id",
    COALESCE("icp_id", '00000000-0000-0000-0000-000000000000'::uuid), "gate_id", "input_digest");
CREATE INDEX "hard_gate_result_lookup_idx"
  ON "hard_gate_result" ("workspace_id", "canonical_company_id", "evaluated_at" DESC);
CREATE INDEX "hard_gate_result_gate_stats_idx"
  ON "hard_gate_result" ("workspace_id", "gate_id", "verdict", "evaluated_at" DESC);

ALTER TABLE "hard_gate_result" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hard_gate_result" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hard_gate_result_tenant" ON "hard_gate_result"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- append-only：只有 SELECT + INSERT（无 UPDATE/DELETE）。
REVOKE ALL ON TABLE "hard_gate_result" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "hard_gate_result" FROM app_user;
GRANT SELECT, INSERT ON TABLE "hard_gate_result" TO app_user;

-- ② 门补数队列（有状态机）：UNKNOWN 硬门进这里排期补数。
CREATE TABLE "gate_enrichment_task" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "canonical_company_id" UUID NOT NULL,
  "icp_id" UUID,
  "gate_id" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gate_enrichment_task_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_enrichment_task_status_check"
    CHECK ("status" IN ('queued', 'running', 'filled', 'abandoned'))
);
CREATE UNIQUE INDEX "gate_enrichment_task_key"
  ON "gate_enrichment_task" ("workspace_id", "canonical_company_id",
    COALESCE("icp_id", '00000000-0000-0000-0000-000000000000'::uuid), "gate_id");

ALTER TABLE "gate_enrichment_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_enrichment_task" FORCE ROW LEVEL SECURITY;
CREATE POLICY "gate_enrichment_task_tenant" ON "gate_enrichment_task"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- 状态机：SELECT + INSERT + UPDATE，无 DELETE。
REVOKE ALL ON TABLE "gate_enrichment_task" FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "gate_enrichment_task" FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "gate_enrichment_task" TO app_user;

-- ③ 不可变判定记录（append-only）：一次 judge 尝试一行，永不更新、永不删除。
CREATE TABLE "judgment_record" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID,
  "icp_id" UUID NOT NULL,
  "canonical_company_id" UUID NOT NULL,
  "judge_level" SMALLINT NOT NULL,
  "verdict" TEXT NOT NULL,
  "verdict_proposed" TEXT,
  "criteria" JSONB NOT NULL,
  "evidence_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "evidence_completeness" BOOLEAN NOT NULL,
  "rubric_version" TEXT NOT NULL,
  "prompt_hash" CHAR(64) NOT NULL,
  "schema_version" TEXT NOT NULL,
  "input_digest" CHAR(64) NOT NULL,
  "output_digest" CHAR(64) NOT NULL,
  "model_requested" TEXT NOT NULL,
  "model_resolved" TEXT,
  "model_reported" TEXT,
  "sampling" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "stage" TEXT,
  "cause" TEXT,
  "outcome" TEXT,
  "retryable" BOOLEAN,
  "failure_code" TEXT,
  "latency_ms" INTEGER,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "cost_micros" BIGINT,
  "attempt" SMALLINT NOT NULL DEFAULT 1,
  "durable_receipt" JSONB,
  "conformal_score" DOUBLE PRECISION,
  "conformal_threshold_version" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "judgment_record_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "judgment_record_level_check" CHECK ("judge_level" IN (1, 2, 3)),
  CONSTRAINT "judgment_record_verdict_check" CHECK ("verdict" IN ('FIT', 'NOT_FIT', 'UNKNOWN')),
  CONSTRAINT "judgment_record_criteria_check" CHECK (jsonb_typeof("criteria") = 'array'),
  CONSTRAINT "judgment_record_evidence_check" CHECK (jsonb_typeof("evidence_refs") = 'array'),
  CONSTRAINT "judgment_record_sampling_check" CHECK (jsonb_typeof("sampling") = 'object'),
  CONSTRAINT "judgment_record_digest_check" CHECK ("input_digest" ~ '^[0-9a-f]{64}$'
    AND "output_digest" ~ '^[0-9a-f]{64}$' AND "prompt_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "judgment_record_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('retry', 'failover', 'degraded', 'failed', 'skipped')),
  CONSTRAINT "judgment_record_stage_check" CHECK ("stage" IS NULL OR "stage" IN
    ('provider', 'parser', 'retriever', 'guardrail', 'tool', 'budget', 'dispatch', 'storage')),
  -- 单列 FK（见文件头 FK 修正说明）。
  CONSTRAINT "judgment_record_run_fkey" FOREIGN KEY ("run_id")
    REFERENCES "discovery_run"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT "judgment_record_company_fkey" FOREIGN KEY ("canonical_company_id")
    REFERENCES "canonical_company"("id") ON DELETE CASCADE,
  CONSTRAINT "judgment_record_icp_fkey" FOREIGN KEY ("icp_id")
    REFERENCES "icp_definition"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "judgment_record_replay_key"
  ON "judgment_record" ("workspace_id", "canonical_company_id", "icp_id", "input_digest",
    "rubric_version", "prompt_hash", "judge_level", "attempt");
CREATE INDEX "judgment_record_company_idx"
  ON "judgment_record" ("workspace_id", "canonical_company_id", "created_at" DESC);
CREATE INDEX "judgment_record_icp_verdict_idx"
  ON "judgment_record" ("workspace_id", "icp_id", "verdict", "created_at" DESC);
CREATE INDEX "judgment_record_failure_idx"
  ON "judgment_record" ("workspace_id", "failure_code", "created_at" DESC)
  WHERE "failure_code" IS NOT NULL;
CREATE INDEX "judgment_record_prompt_idx" ON "judgment_record" ("prompt_hash");

ALTER TABLE "judgment_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "judgment_record" FORCE ROW LEVEL SECURITY;
CREATE POLICY "judgment_record_tenant" ON "judgment_record"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- append-only：只有 SELECT + INSERT（无 UPDATE/DELETE）。
REVOKE ALL ON TABLE "judgment_record" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "judgment_record" FROM app_user;
GRANT SELECT, INSERT ON TABLE "judgment_record" TO app_user;

-- ④ conformal 阈值工件（全局表，无 workspace_id，不开 RLS）。
CREATE TABLE "conformal_threshold" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version" TEXT NOT NULL,
  "alpha" DOUBLE PRECISION NOT NULL,
  "delta" DOUBLE PRECISION NOT NULL,
  "scope" TEXT NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "calibration_n" INTEGER NOT NULL,
  "accepted_n" INTEGER NOT NULL,
  "accepted_errors" INTEGER NOT NULL,
  "upper_bound" DOUBLE PRECISION NOT NULL,
  "dataset_digest" CHAR(64) NOT NULL,
  "rubric_version" TEXT NOT NULL,
  "prompt_hash" CHAR(64) NOT NULL,
  "model_resolved" TEXT NOT NULL,
  "fitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "active" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "conformal_threshold_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "conformal_threshold_version_key" ON "conformal_threshold" ("version");
-- 单活约束：同一 scope 同时只有一个 active。
CREATE UNIQUE INDEX "conformal_threshold_active_key" ON "conformal_threshold" ("scope")
  WHERE "active";

-- 全局阈值工件：app_user 只读（写入只允许 owner 的拟合任务）。
REVOKE ALL ON TABLE "conformal_threshold" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "conformal_threshold" FROM app_user;
GRANT SELECT ON TABLE "conformal_threshold" TO app_user;

-- ⑤ 人工复核队列（有状态机）：queued → in_review → resolved；超时 → expired。
CREATE TABLE "judgment_review_task" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "judgment_record_id" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "priority" SMALLINT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "assignee" TEXT,
  "due_at" TIMESTAMPTZ(3),
  "resolved_verdict" TEXT,
  "resolved_by" TEXT,
  "resolved_at" TIMESTAMPTZ(3),
  "resolution_note" TEXT,
  "reflowed_label_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "judgment_review_task_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "judgment_review_task_priority_check" CHECK ("priority" BETWEEN 0 AND 3),
  CONSTRAINT "judgment_review_task_status_check"
    CHECK ("status" IN ('queued', 'in_review', 'resolved', 'expired')),
  CONSTRAINT "judgment_review_task_reason_check" CHECK ("reason" IN ('UNKNOWN', 'BORDERLINE',
    'RANDOM_AUDIT', 'DRIFT_AUDIT', 'APPEAL', 'CONFORMAL_ABSTAIN')),
  CONSTRAINT "judgment_review_task_verdict_check"
    CHECK ("resolved_verdict" IS NULL OR "resolved_verdict" IN ('FIT', 'NOT_FIT', 'UNKNOWN'))
);
CREATE INDEX "judgment_review_task_queue_idx"
  ON "judgment_review_task" ("workspace_id", "status", "priority", "due_at");
CREATE UNIQUE INDEX "judgment_review_task_record_key"
  ON "judgment_review_task" ("judgment_record_id", "reason");

ALTER TABLE "judgment_review_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "judgment_review_task" FORCE ROW LEVEL SECURITY;
CREATE POLICY "judgment_review_task_tenant" ON "judgment_review_task"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- 状态机：SELECT + INSERT + UPDATE，无 DELETE。
REVOKE ALL ON TABLE "judgment_review_task" FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "judgment_review_task" FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "judgment_review_task" TO app_user;

-- ⑥ 金标回流（append-only）：复核结论进入校准/测试集。
CREATE TABLE "judgment_golden_label" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "canonical_company_id" UUID NOT NULL,
  "icp_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "label_source" TEXT NOT NULL,
  "review_task_id" UUID,
  "annotator_hash" TEXT,
  "rubric_version" TEXT NOT NULL,
  "input_digest" CHAR(64) NOT NULL,
  "split" TEXT NOT NULL,
  "labeled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "judgment_golden_label_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "judgment_golden_label_label_check" CHECK ("label" IN ('FIT', 'NOT_FIT', 'UNKNOWN')),
  CONSTRAINT "judgment_golden_label_source_check"
    CHECK ("label_source" IN ('double_annotated', 'adjudicated', 'review', 'external')),
  CONSTRAINT "judgment_golden_label_split_check"
    CHECK ("split" IN ('calib', 'test', 'candidate', 'retired'))
);
CREATE INDEX "judgment_golden_label_lookup_idx"
  ON "judgment_golden_label" ("workspace_id", "canonical_company_id", "icp_id", "labeled_at" DESC);

ALTER TABLE "judgment_golden_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "judgment_golden_label" FORCE ROW LEVEL SECURITY;
CREATE POLICY "judgment_golden_label_tenant" ON "judgment_golden_label"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- append-only：只有 SELECT + INSERT（无 UPDATE/DELETE）。
REVOKE ALL ON TABLE "judgment_golden_label" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "judgment_golden_label" FROM app_user;
GRANT SELECT, INSERT ON TABLE "judgment_golden_label" TO app_user;

COMMIT;
