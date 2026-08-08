-- Signal ingest first-line concurrency control. Existing OK/ERROR rows remain
-- valid; only a PENDING row with a live lease may own external egress.
ALTER TABLE "signal_ingest"
  ADD COLUMN "lease_owner" TEXT,
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "lease_fence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "started_at" TIMESTAMP(3),
  ADD COLUMN "completed_at" TIMESTAMP(3),
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "signal_ingest" ALTER COLUMN "status" SET DEFAULT 'PENDING';
ALTER TABLE "signal_ingest"
  ADD CONSTRAINT "signal_ingest_status_check"
  CHECK ("status" IN ('PENDING', 'OK', 'ERROR'));
ALTER TABLE "signal_ingest"
  ADD CONSTRAINT "signal_ingest_lease_state_check"
  CHECK (
    (
      "status" = 'PENDING'
      AND "lease_owner" IS NOT NULL
      AND "lease_token" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL
      AND "completed_at" IS NULL
    )
    OR
    (
      "status" IN ('OK', 'ERROR')
      AND "lease_owner" IS NULL
      AND "lease_token" IS NULL
      AND "lease_expires_at" IS NULL
    )
  );
ALTER TABLE "signal_ingest"
  ADD CONSTRAINT "signal_ingest_attempt_check" CHECK ("attempt" >= 0);
ALTER TABLE "signal_ingest"
  ADD CONSTRAINT "signal_ingest_lease_fence_check" CHECK ("lease_fence" >= 0);
ALTER TABLE "signal_ingest"
  ADD CONSTRAINT "signal_ingest_lease_owner_check" CHECK (
    "lease_owner" IS NULL OR "lease_owner" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
  );
CREATE INDEX "signal_ingest_status_lease_expires_at_idx"
  ON "signal_ingest"("status", "lease_expires_at");
REVOKE DELETE ON TABLE "signal_ingest" FROM app_user;

CREATE TABLE "workflow_run_receipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "receipt_key" TEXT NOT NULL,
  "workspace_id" UUID,
  "workflow_id" TEXT NOT NULL,
  "run_id" UUID NOT NULL,
  "workflow_type" TEXT NOT NULL,
  "task_queue" TEXT NOT NULL,
  "worker_build_sha" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "stats" JSONB NOT NULL,
  "error_code" TEXT,
  "budget_truncated" BOOLEAN NOT NULL DEFAULT false,
  "retry_attempt" INTEGER NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_run_receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_run_receipt_key_check" CHECK (
    "receipt_key" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "workflow_run_receipt_workflow_id_check" CHECK (
    "workflow_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
    AND "workflow_id" !~ '@'
  ),
  CONSTRAINT "workflow_run_receipt_workflow_type_check" CHECK (
    "workflow_type" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
  ),
  CONSTRAINT "workflow_run_receipt_task_queue_check" CHECK (
    "task_queue" IN ('understanding', 'acquisition', 'site-builder', 'maintenance')
  ),
  CONSTRAINT "workflow_run_receipt_build_sha_check" CHECK (
    "worker_build_sha" = 'development-unattested'
    OR "worker_build_sha" ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
  ),
  CONSTRAINT "workflow_run_receipt_phase_check" CHECK ("phase" IN ('STARTED', 'COMPLETED', 'FAILED')),
  CONSTRAINT "workflow_run_receipt_stage_check" CHECK (
    "stage" ~ '^[a-z][a-z0-9_.:-]{0,63}$'
  ),
  CONSTRAINT "workflow_run_receipt_stats_check" CHECK (
    jsonb_typeof("stats") = 'object'
  ),
  CONSTRAINT "workflow_run_receipt_retry_check" CHECK (
    "retry_attempt" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT "workflow_run_receipt_error_code_check" CHECK (
    "error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);
CREATE UNIQUE INDEX "workflow_run_receipt_receipt_key_key"
  ON "workflow_run_receipt"("receipt_key");
CREATE INDEX "workflow_run_receipt_workspace_id_recorded_at_idx"
  ON "workflow_run_receipt"("workspace_id", "recorded_at");
CREATE INDEX "workflow_run_receipt_phase_recorded_at_idx"
  ON "workflow_run_receipt"("phase", "recorded_at");
CREATE INDEX "workflow_run_receipt_budget_truncated_recorded_at_idx"
  ON "workflow_run_receipt"("budget_truncated", "recorded_at");

CREATE TABLE "worker_heartbeat" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "worker_instance_id" UUID NOT NULL,
  "task_queue" TEXT NOT NULL,
  "worker_build_sha" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "activity_concurrency" INTEGER NOT NULL,
  "workflow_concurrency" INTEGER NOT NULL,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "worker_heartbeat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "worker_heartbeat_task_queue_check" CHECK (
    "task_queue" IN ('understanding', 'acquisition', 'site-builder', 'maintenance')
  ),
  CONSTRAINT "worker_heartbeat_build_sha_check" CHECK (
    "worker_build_sha" = 'development-unattested'
    OR "worker_build_sha" ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
  ),
  CONSTRAINT "worker_heartbeat_status_check" CHECK ("status" IN ('POLLING', 'STOPPING')),
  CONSTRAINT "worker_heartbeat_activity_concurrency_check" CHECK ("activity_concurrency" BETWEEN 1 AND 64),
  CONSTRAINT "worker_heartbeat_workflow_concurrency_check" CHECK ("workflow_concurrency" BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX "worker_heartbeat_worker_instance_id_task_queue_key"
  ON "worker_heartbeat"("worker_instance_id", "task_queue");
CREATE INDEX "worker_heartbeat_task_queue_last_seen_at_idx"
  ON "worker_heartbeat"("task_queue", "last_seen_at");

CREATE TABLE "schedule_drift_receipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schedule_id" TEXT NOT NULL,
  "disposition" TEXT NOT NULL,
  "desired_hash" TEXT NOT NULL,
  "observed_hash" TEXT,
  "changed_fields" JSONB NOT NULL,
  "error_code" TEXT,
  "paused" BOOLEAN,
  "next_action_at" TIMESTAMP(3),
  "missed_catchup_count" INTEGER,
  "skipped_overlap_count" INTEGER,
  "worker_build_sha" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schedule_drift_receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_drift_receipt_schedule_id_check" CHECK (
    "schedule_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
  ),
  CONSTRAINT "schedule_drift_receipt_disposition_check" CHECK (
    "disposition" IN ('CREATED', 'IN_SYNC', 'RECONCILED', 'FAILED')
  ),
  CONSTRAINT "schedule_drift_receipt_desired_hash_check" CHECK (
    "desired_hash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "schedule_drift_receipt_observed_hash_check" CHECK (
    "observed_hash" IS NULL OR "observed_hash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "schedule_drift_receipt_changed_fields_check" CHECK (
    jsonb_typeof("changed_fields") = 'array'
    AND jsonb_array_length("changed_fields") <= 8
  ),
  CONSTRAINT "schedule_drift_receipt_error_code_check" CHECK (
    "error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT "schedule_drift_receipt_build_sha_check" CHECK (
    "worker_build_sha" = 'development-unattested'
    OR "worker_build_sha" ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
  ),
  CONSTRAINT "schedule_drift_receipt_missed_catchup_count_check" CHECK (
    "missed_catchup_count" IS NULL OR "missed_catchup_count" >= 0
  ),
  CONSTRAINT "schedule_drift_receipt_skipped_overlap_count_check" CHECK (
    "skipped_overlap_count" IS NULL OR "skipped_overlap_count" >= 0
  )
);
CREATE INDEX "schedule_drift_receipt_schedule_id_recorded_at_idx"
  ON "schedule_drift_receipt"("schedule_id", "recorded_at");
CREATE INDEX "schedule_drift_receipt_disposition_recorded_at_idx"
  ON "schedule_drift_receipt"("disposition", "recorded_at");

-- Tenant receipts are visible only inside the signed workspace context. Rows
-- with NULL workspace_id are platform-only and remain invisible to app_user.
ALTER TABLE "workflow_run_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_run_receipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_run_receipt_workspace_isolation"
  ON "workflow_run_receipt"
  FOR SELECT
  TO app_user
  USING ("workspace_id" = current_workspace_id());
-- FORCE RLS also applies to a non-BYPASSRLS table owner. Keep the trusted
-- platform worker/read path explicit while app_user remains constrained by the
-- role-specific workspace policy and has no write privilege.
CREATE POLICY "workflow_run_receipt_platform_read"
  ON "workflow_run_receipt"
  FOR SELECT
  USING (current_user <> 'app_user');
CREATE POLICY "workflow_run_receipt_platform_insert"
  ON "workflow_run_receipt"
  FOR INSERT
  WITH CHECK (current_user <> 'app_user');

GRANT SELECT ON TABLE "workflow_run_receipt" TO app_user;
GRANT SELECT ON TABLE "worker_heartbeat" TO app_user;
GRANT SELECT ON TABLE "schedule_drift_receipt" TO app_user;
REVOKE INSERT, UPDATE, DELETE ON TABLE "workflow_run_receipt" FROM app_user;
REVOKE INSERT, UPDATE, DELETE ON TABLE "worker_heartbeat" FROM app_user;
REVOKE INSERT, UPDATE, DELETE ON TABLE "schedule_drift_receipt" FROM app_user;
REVOKE UPDATE, DELETE ON TABLE "workflow_run_receipt" FROM app_user;
REVOKE UPDATE, DELETE ON TABLE "schedule_drift_receipt" FROM app_user;

CREATE OR REPLACE FUNCTION prevent_runtime_ops_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'runtime ops receipts are append-only';
END;
$$;

CREATE TRIGGER "workflow_run_receipt_append_only"
  BEFORE UPDATE OR DELETE ON "workflow_run_receipt"
  FOR EACH ROW EXECUTE FUNCTION prevent_runtime_ops_receipt_mutation();
CREATE TRIGGER "schedule_drift_receipt_append_only"
  BEFORE UPDATE OR DELETE ON "schedule_drift_receipt"
  FOR EACH ROW EXECUTE FUNCTION prevent_runtime_ops_receipt_mutation();
