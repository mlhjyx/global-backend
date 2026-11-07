-- D-MA-7 记忆与学习层 v0（设计：docs/superpowers/plans/2026-11-08-memory-layer-v0.md，APPROVED）
-- Additive：两张派生表 + outbox 扫描索引；无回填、不改现有表结构。
--   * mem_run_episode：append-only 的 run 事件记忆（app_user 仅 SELECT/INSERT）；
--   * mem_knowledge_stat：Beta-Binomial 统计，只追加版本（app_user 仅 SELECT，写权仅 memory_semantic_writer）；
--   * outbox_event(event_type, occurred_at)：消费者按事件类型 + 回看窗口扫描。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 受信语义写角色：NOLOGIN 组角色，部署时再绑定受信服务主体（v0 无写入代码）。
DO $$
DECLARE
  can_create_role BOOLEAN;
  writer_role pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO writer_role
  FROM pg_roles
  WHERE rolname = 'memory_semantic_writer';

  IF writer_role.oid IS NULL THEN
    SELECT rolsuper OR rolcreaterole INTO can_create_role
    FROM pg_roles
    WHERE rolname = current_user;
    IF NOT COALESCE(can_create_role, false) THEN
      RAISE EXCEPTION 'MEMORY_LAYER_MIGRATION_REQUIRES_CREATEROLE';
    END IF;
    CREATE ROLE memory_semantic_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF writer_role.rolcanlogin
    OR writer_role.rolsuper
    OR writer_role.rolbypassrls
    OR writer_role.rolcreaterole
    OR writer_role.rolcreatedb
    OR writer_role.rolreplication
  THEN
    RAISE EXCEPTION 'MEMORY_SEMANTIC_WRITER_ROLE_INVALID';
  END IF;

  IF pg_has_role('app_user', 'memory_semantic_writer', 'member') THEN
    RAISE EXCEPTION 'MEMORY_SEMANTIC_WRITER_APP_MEMBERSHIP_INVALID';
  END IF;
END $$;

CREATE TABLE "mem_run_episode" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "workflow_type" VARCHAR(32) NOT NULL,
  "run_id" UUID NOT NULL,
  "phase" VARCHAR(32) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "source_event_id" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "provenance" JSONB NOT NULL,
  "privacy_classification" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mem_run_episode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mem_run_episode_phase_check" CHECK ("phase" IN ('run_completed', 'results_backfilled')),
  CONSTRAINT "mem_run_episode_payload_size_check" CHECK (pg_column_size("payload") <= 16384),
  CONSTRAINT "mem_run_episode_run_fkey" FOREIGN KEY ("workspace_id", "run_id")
    REFERENCES "discovery_run"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mem_run_episode_key" UNIQUE ("workspace_id", "workflow_type", "run_id", "phase")
);

CREATE INDEX "mem_run_episode_lookup_idx"
  ON "mem_run_episode"("workspace_id", "workflow_type", "run_id", "occurred_at");
CREATE INDEX "mem_run_episode_event_idx"
  ON "mem_run_episode"("source_event_id");

ALTER TABLE "mem_run_episode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_run_episode" FORCE ROW LEVEL SECURITY;
CREATE POLICY "mem_run_episode_tenant_isolation" ON "mem_run_episode"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT ON TABLE "mem_run_episode" TO app_user;

CREATE TABLE "mem_knowledge_stat" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "scope_type" VARCHAR(32) NOT NULL,
  "scope_key" VARCHAR(200) NOT NULL,
  "stat_key" VARCHAR(64) NOT NULL,
  "successes" INTEGER NOT NULL,
  "failures" INTEGER NOT NULL,
  "valid_from" TIMESTAMP(3) NOT NULL,
  "valid_to" TIMESTAMP(3),
  "supersedes_id" UUID,
  "provenance" JSONB NOT NULL,
  "privacy_classification" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mem_knowledge_stat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mem_knowledge_stat_scope_check" CHECK ("scope_type" IN ('workspace', 'icp', 'source', 'channel', 'industry', 'country')),
  CONSTRAINT "mem_knowledge_stat_key_check" CHECK (char_length("scope_key") BETWEEN 1 AND 200 AND char_length("stat_key") BETWEEN 1 AND 64),
  CONSTRAINT "mem_knowledge_stat_counts_check" CHECK ("successes" >= 0 AND "failures" >= 0),
  CONSTRAINT "mem_knowledge_stat_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
  CONSTRAINT "mem_knowledge_stat_key" UNIQUE ("workspace_id", "scope_type", "scope_key", "stat_key", "valid_from")
);

CREATE INDEX "mem_knowledge_stat_lookup_idx"
  ON "mem_knowledge_stat"("workspace_id", "scope_type", "scope_key", "stat_key", "valid_from");

ALTER TABLE "mem_knowledge_stat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_knowledge_stat" FORCE ROW LEVEL SECURITY;
CREATE POLICY "mem_knowledge_stat_tenant_isolation" ON "mem_knowledge_stat"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- 语义表防投毒：普通 app_user 只读；写权只给受信组角色。
GRANT SELECT ON TABLE "mem_knowledge_stat" TO app_user;
GRANT USAGE ON SCHEMA public TO memory_semantic_writer;
GRANT SELECT, INSERT ON TABLE "mem_knowledge_stat" TO memory_semantic_writer;

-- 记忆消费者的扫描路径：事件类型 + 回看窗口。
CREATE INDEX "outbox_event_type_occurred_idx"
  ON "outbox_event"("event_type", "occurred_at");

COMMIT;
