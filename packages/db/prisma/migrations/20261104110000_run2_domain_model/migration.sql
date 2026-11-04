-- M0①（Run 2.0 域模型，2026-11-04 完整设计 §6.1 / §7「迁移 expand-only」）：
--   * discovery_run 增 task_ref / phases / mode（全部可空或带默认，旧行可读，无回填）；
--   * canonical_company 增 last_seen_at / last_checked_at / profile_hash（公司池新鲜度）；
--   * lead 增 fit_input_hash（fit 缓存键）；
--   * 新表 discovery_company_job（公司级流水线状态）、run_event（append-only 进度事件）、
--     company_channel_sighting（渠道来源证据；channel_id 在 M1 接 source_channel 时加外键）。
-- Additive, no backfill, no old-column semantic change. Deploy in name order together with the image.
-- Rollback: a later migration that drops the three new tables then the added columns (nothing
-- references the columns before the M0②+ code ships).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "discovery_run"
  ADD COLUMN "task_ref" JSONB,
  ADD COLUMN "phases" JSONB,
  ADD COLUMN "mode" VARCHAR(16) NOT NULL DEFAULT 'full';

ALTER TABLE "canonical_company"
  ADD COLUMN "last_seen_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_checked_at" TIMESTAMPTZ(3),
  ADD COLUMN "profile_hash" VARCHAR(64);

ALTER TABLE "lead"
  ADD COLUMN "fit_input_hash" VARCHAR(64);

CREATE INDEX "canonical_company_workspace_last_seen_idx"
  ON "canonical_company"("workspace_id", "last_seen_at");

CREATE TABLE "discovery_company_job" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "canonical_company_id" UUID NOT NULL,
  "stage" VARCHAR(32) NOT NULL DEFAULT 'queued',
  "verdict_quick" VARCHAR(16),
  "verdict_deep" VARCHAR(16),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" VARCHAR(64),
  "lease_until" TIMESTAMPTZ(3),
  "cost_cents" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "discovery_company_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "discovery_company_job_stage_check" CHECK (
    "stage" IN (
      'queued',
      'prefiltered_out',
      'quick_judged',
      'profiling',
      'fitting',
      'signals',
      'contacts',
      'done',
      'failed',
      'skipped'
    )
  ),
  CONSTRAINT "discovery_company_job_verdict_quick_check" CHECK (
    "verdict_quick" IS NULL OR "verdict_quick" IN ('match', 'weak', 'mismatch')
  ),
  CONSTRAINT "discovery_company_job_verdict_deep_check" CHECK (
    "verdict_deep" IS NULL OR "verdict_deep" IN ('match', 'weak', 'mismatch')
  ),
  CONSTRAINT "discovery_company_job_attempts_check" CHECK ("attempts" BETWEEN 0 AND 100),
  CONSTRAINT "discovery_company_job_cost_check" CHECK ("cost_cents" BETWEEN 0 AND 100000000),
  CONSTRAINT "discovery_company_job_run_fkey" FOREIGN KEY ("workspace_id", "run_id")
    REFERENCES "discovery_run"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "discovery_company_job_run_company_key"
  ON "discovery_company_job"("workspace_id", "run_id", "canonical_company_id");

CREATE INDEX "discovery_company_job_workspace_run_stage_idx"
  ON "discovery_company_job"("workspace_id", "run_id", "stage");

ALTER TABLE "discovery_company_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discovery_company_job" FORCE ROW LEVEL SECURITY;
CREATE POLICY "discovery_company_job_tenant_isolation" ON "discovery_company_job"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "discovery_company_job" TO app_user;

CREATE TABLE "run_event" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "seq" BIGINT NOT NULL,
  "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "level" VARCHAR(16) NOT NULL DEFAULT 'info',
  "type" VARCHAR(48) NOT NULL,
  "payload" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "run_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_event_seq_check" CHECK ("seq" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "run_event_level_check" CHECK ("level" IN ('info', 'warn', 'error')),
  CONSTRAINT "run_event_type_check" CHECK (
    "type" IN (
      'phase_started',
      'phase_completed',
      'company_entered_stage',
      'company_done',
      'company_failed',
      'budget_exhausted',
      'lease_skipped',
      'run_finished'
    )
  ),
  CONSTRAINT "run_event_run_fkey" FOREIGN KEY ("workspace_id", "run_id")
    REFERENCES "discovery_run"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "run_event_run_seq_key" ON "run_event"("run_id", "seq");

CREATE INDEX "run_event_workspace_run_seq_idx"
  ON "run_event"("workspace_id", "run_id", "seq");

ALTER TABLE "run_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "run_event_tenant_isolation" ON "run_event"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- append-only：进度事件写入后不再修改（90 天保留期清理走 owner/平台侧，见 M0⑥）。
GRANT SELECT, INSERT ON TABLE "run_event" TO app_user;

CREATE TABLE "company_channel_sighting" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "channel_id" UUID,
  "evidence_url" VARCHAR(2048),
  "external_ref" VARCHAR(200),
  "seen_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "company_channel_sighting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_channel_sighting_evidence_check" CHECK (
    "evidence_url" IS NULL
    OR ("evidence_url" LIKE 'https://%' AND char_length("evidence_url") <= 2048)
  ),
  CONSTRAINT "company_channel_sighting_external_ref_check" CHECK (
    "external_ref" IS NULL
    OR char_length("external_ref") BETWEEN 1 AND 200
  ),
  CONSTRAINT "company_channel_sighting_company_fkey" FOREIGN KEY ("workspace_id", "company_id")
    REFERENCES "canonical_company"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "company_channel_sighting_identity_key"
  ON "company_channel_sighting"("workspace_id", "company_id", "channel_id", "external_ref");

CREATE INDEX "company_channel_sighting_workspace_company_seen_idx"
  ON "company_channel_sighting"("workspace_id", "company_id", "seen_at");

CREATE INDEX "company_channel_sighting_workspace_channel_seen_idx"
  ON "company_channel_sighting"("workspace_id", "channel_id", "seen_at");

ALTER TABLE "company_channel_sighting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_channel_sighting" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_channel_sighting_tenant_isolation" ON "company_channel_sighting"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT ON TABLE "company_channel_sighting" TO app_user;

COMMIT;
