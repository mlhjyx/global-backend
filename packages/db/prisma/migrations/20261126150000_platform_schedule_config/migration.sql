-- M10-PR3: Internal DB Kill Switch configuration table for the 4 platform schedules
-- when PLATFORM_AUTHORITY_MODE=internal_db (defaults to r4; zero-breaking additive migration).
-- All 4 canonical platform schedules are seeded with enabled = false (fail-closed / no accidental egress).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "platform_schedule_config" (
  "schedule_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "updated_by" TEXT NOT NULL DEFAULT 'migration',
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_schedule_config_pkey" PRIMARY KEY ("schedule_id")
);

ALTER TABLE "platform_schedule_config"
  ADD CONSTRAINT "platform_schedule_config_schedule_id_chk"
  CHECK (
    "schedule_id" IN (
      'acq-sweep',
      'intent-sweep',
      'sanctions-refresh',
      'patents-cache-refresh'
    )
  ) NOT VALID;
ALTER TABLE "platform_schedule_config"
  VALIDATE CONSTRAINT "platform_schedule_config_schedule_id_chk";

ALTER TABLE "platform_schedule_config"
  ADD CONSTRAINT "platform_schedule_config_updated_by_chk"
  CHECK (char_length(btrim("updated_by")) BETWEEN 1 AND 128) NOT VALID;
ALTER TABLE "platform_schedule_config"
  VALIDATE CONSTRAINT "platform_schedule_config_updated_by_chk";

INSERT INTO "platform_schedule_config" ("schedule_id", "enabled", "updated_by")
VALUES
  ('acq-sweep', false, 'migration'),
  ('intent-sweep', false, 'migration'),
  ('sanctions-refresh', false, 'migration'),
  ('patents-cache-refresh', false, 'migration')
ON CONFLICT ("schedule_id") DO NOTHING;

-- Strict least-privilege ACL:
--   * PUBLIC: zero access
--   * app_user: SELECT only (tenant/app layer can never toggle platform Kill Switches)
--   * execution_budget_platform_writer & platform_writer: SELECT, INSERT, UPDATE (never DELETE/TRUNCATE)
REVOKE ALL ON TABLE "platform_schedule_config" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "platform_schedule_config" FROM app_user;
GRANT SELECT ON TABLE "platform_schedule_config" TO app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "platform_schedule_config" TO execution_budget_platform_writer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_writer') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "platform_schedule_config" TO platform_writer;
  END IF;
END
$$;

COMMIT;
