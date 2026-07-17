-- R3-B2: first-class, replay-safe Site Builder progress records.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "site_build_run" IN SHARE ROW EXCLUSIVE MODE;

CREATE UNIQUE INDEX "site_build_run_id_workspace_id_key"
  ON "site_build_run"("id", "workspace_id");

CREATE TABLE "site_build_step" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "item_key" TEXT NOT NULL DEFAULT '',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "progress" DOUBLE PRECISION NOT NULL,
  "degraded" BOOLEAN NOT NULL DEFAULT false,
  "error_code" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_build_step_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_step_status_check"
    CHECK ("status" IN ('queued', 'running', 'done', 'degraded', 'failed', 'skipped', 'aborted')),
  CONSTRAINT "site_build_step_key_check"
    CHECK ("key" IN ('kb_ingest', 'brand_profile', 'image_pipeline', 'copy', 'assemble_build', 'quality_loop')),
  CONSTRAINT "site_build_step_phase_check"
    CHECK ("phase" IN ('P1_understanding', 'P2_assets', 'P3_assembly', 'P5_publish')),
  CONSTRAINT "site_build_step_attempt_check" CHECK ("attempt" >= 1),
  CONSTRAINT "site_build_step_progress_check" CHECK ("progress" >= 0 AND "progress" <= 1),
  CONSTRAINT "site_build_step_item_key_length_check" CHECK (char_length("item_key") <= 512),
  CONSTRAINT "site_build_step_error_code_length_check"
    CHECK ("error_code" IS NULL OR char_length("error_code") <= 128),
  CONSTRAINT "site_build_step_terminal_time_check"
    CHECK (
      ("status" IN ('done', 'degraded', 'failed', 'skipped', 'aborted') AND "finished_at" IS NOT NULL)
      OR ("status" IN ('queued', 'running') AND "finished_at" IS NULL)
    ),
  CONSTRAINT "site_build_step_build_run_id_workspace_id_fkey"
    FOREIGN KEY ("build_run_id", "workspace_id")
    REFERENCES "site_build_run"("id", "workspace_id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "site_build_step_build_run_id_key_item_key_attempt_key"
  ON "site_build_step"("build_run_id", "key", "item_key", "attempt");
CREATE INDEX "site_build_step_workspace_id_build_run_id_idx"
  ON "site_build_step"("workspace_id", "build_run_id");

ALTER TABLE "site_build_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_step" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_build_step_workspace_isolation" ON "site_build_step"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "site_build_step" TO app_user;

COMMIT;
