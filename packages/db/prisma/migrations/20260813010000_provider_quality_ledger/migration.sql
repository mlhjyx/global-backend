-- Provider quality ledger: additive, immutable run contributions only.
-- Historical DiscoveryRun rows are intentionally not backfilled because old
-- stats do not contain truthful provider-keyed attempt and failure facts.

ALTER TABLE "discovery_run"
  ADD CONSTRAINT "discovery_run_workspace_id_id_key" UNIQUE ("workspace_id", "id");

CREATE TABLE "provider_quality_run_contribution" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "icp_id" UUID,
  "provider_key" VARCHAR(128) NOT NULL,
  "terminal_status" VARCHAR(16) NOT NULL,
  "attempted_count" INTEGER NOT NULL,
  "success_count" INTEGER NOT NULL,
  "zero_result_count" INTEGER NOT NULL,
  "failure_count" INTEGER NOT NULL,
  "failed_run_count" INTEGER NOT NULL,
  "processed_count" INTEGER NOT NULL,
  "raw_count" INTEGER NOT NULL,
  "accepted_count" INTEGER,
  "bound_count" INTEGER,
  "domain_count" INTEGER,
  "authority_count" INTEGER,
  "conflict_count" INTEGER,
  "duplicate_count" INTEGER NOT NULL,
  "completed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "provider_quality_run_contribution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_quality_run_contribution_terminal_status_check"
    CHECK ("terminal_status" IN ('DONE', 'PARTIAL', 'FAILED')),
  CONSTRAINT "provider_quality_run_contribution_provider_key_check"
    CHECK (length(btrim("provider_key")) BETWEEN 1 AND 128 AND "provider_key" = btrim("provider_key") AND position('+' in "provider_key") = 0),
  CONSTRAINT "provider_quality_run_contribution_attempt_accounting_check"
    CHECK (
      "attempted_count" >= 1 AND
      "success_count" >= 0 AND
      "failure_count" >= 0 AND
      "success_count" + "failure_count" = "attempted_count" AND
      "zero_result_count" BETWEEN 0 AND "success_count" AND
      "failed_run_count" IN (0, 1) AND
      "failed_run_count" = CASE WHEN "failure_count" > 0 THEN 1 ELSE 0 END
    ),
  CONSTRAINT "provider_quality_run_contribution_row_accounting_check"
    CHECK (
      "processed_count" >= 0 AND
      "raw_count" >= 0 AND
      "duplicate_count" >= 0 AND
      "duplicate_count" <= "processed_count"
    ),
  CONSTRAINT "provider_quality_run_contribution_identity_accounting_check"
    CHECK (
      ("accepted_count" IS NULL OR "accepted_count" >= 0) AND
      ("bound_count" IS NULL OR ("bound_count" >= 0 AND "accepted_count" IS NOT NULL AND "bound_count" <= "accepted_count")) AND
      ("domain_count" IS NULL OR ("domain_count" >= 0 AND "accepted_count" IS NOT NULL AND "domain_count" <= "accepted_count")) AND
      ("authority_count" IS NULL OR ("authority_count" >= 0 AND "accepted_count" IS NOT NULL AND "authority_count" <= "accepted_count")) AND
      ("conflict_count" IS NULL OR ("conflict_count" >= 0 AND "accepted_count" IS NOT NULL AND "conflict_count" <= "accepted_count"))
    ),
  CONSTRAINT "provider_quality_run_contribution_workspace_run_provider_key"
    UNIQUE ("workspace_id", "run_id", "provider_key"),
  CONSTRAINT "provider_quality_run_contribution_workspace_run_fkey"
    FOREIGN KEY ("workspace_id", "run_id")
    REFERENCES "discovery_run"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "provider_quality_run_contribution_workspace_completed_idx"
  ON "provider_quality_run_contribution"("workspace_id", "completed_at");
CREATE INDEX "provider_quality_contribution_ws_provider_completed_idx"
  ON "provider_quality_run_contribution"("workspace_id", "provider_key", "completed_at");

ALTER TABLE "provider_quality_run_contribution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_quality_run_contribution" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_quality_run_contribution_tenant_isolation"
  ON "provider_quality_run_contribution"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- The app role cannot reserve the unique run/provider key before finalization,
-- nor insert a plausible-looking row whose counters differ from run.stats.
CREATE OR REPLACE FUNCTION validate_provider_quality_contribution_insert()
RETURNS trigger AS $$
DECLARE
  parent_status text;
  parent_icp_id uuid;
  parent_completed_at timestamp(3);
  parent_stats jsonb;
  provider_facts jsonb;
  identity_facts jsonb;
  expected_accepted integer;
  expected_bound integer;
  expected_domain integer;
  expected_authority integer;
  expected_conflict integer;
  expected_attempted integer;
  expected_success integer;
  expected_zero_result integer;
  expected_failure integer;
  expected_failed_run integer;
  expected_raw integer;
  expected_quarantined integer;
  expected_rejected integer;
  expected_duplicate integer;
  expected_processed integer;
BEGIN
  SELECT status, icp_id, completed_at, stats
    INTO parent_status, parent_icp_id, parent_completed_at, parent_stats
    FROM discovery_run
   WHERE workspace_id = NEW.workspace_id AND id = NEW.run_id;

  IF NOT FOUND OR parent_status NOT IN ('DONE', 'PARTIAL', 'FAILED') OR parent_completed_at IS NULL THEN
    RAISE EXCEPTION 'provider quality contribution requires a terminal parent run';
  END IF;
  provider_facts := parent_stats -> 'perProvider' -> NEW.provider_key;
  identity_facts := parent_stats -> 'identityQuality' -> NEW.provider_key;
  IF jsonb_typeof(provider_facts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'provider quality contribution provider is absent from parent run facts';
  END IF;

  IF jsonb_typeof(provider_facts -> 'attemptedCount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(provider_facts -> 'successCount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(provider_facts -> 'zeroResultCount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(provider_facts -> 'failureCount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(provider_facts -> 'rawCount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(provider_facts -> 'quarantinedCount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(provider_facts -> 'rejectedCount') IS DISTINCT FROM 'number'
    OR jsonb_typeof(provider_facts -> 'duplicateCount') IS DISTINCT FROM 'number'
  THEN
    RAISE EXCEPTION 'provider quality contribution parent run facts are malformed';
  END IF;

  expected_attempted := (provider_facts ->> 'attemptedCount')::integer;
  expected_success := (provider_facts ->> 'successCount')::integer;
  expected_zero_result := (provider_facts ->> 'zeroResultCount')::integer;
  expected_failure := (provider_facts ->> 'failureCount')::integer;
  expected_raw := (provider_facts ->> 'rawCount')::integer;
  expected_quarantined := (provider_facts ->> 'quarantinedCount')::integer;
  expected_rejected := (provider_facts ->> 'rejectedCount')::integer;
  expected_duplicate := (provider_facts ->> 'duplicateCount')::integer;
  expected_processed := expected_raw + expected_quarantined + expected_rejected + expected_duplicate;

  IF expected_failure > 0 THEN
    expected_failed_run := 1;
  ELSE
    expected_failed_run := 0;
  END IF;

  IF jsonb_typeof(identity_facts -> 'acceptedRows') = 'number' THEN
    expected_accepted := (identity_facts ->> 'acceptedRows')::integer;
  END IF;
  IF jsonb_typeof(identity_facts -> 'boundRows') = 'number' THEN
    expected_bound := (identity_facts ->> 'boundRows')::integer;
  END IF;
  IF jsonb_typeof(identity_facts -> 'domainRows') = 'number' THEN
    expected_domain := (identity_facts ->> 'domainRows')::integer;
  END IF;
  IF jsonb_typeof(identity_facts -> 'authorityIdentifierRows') = 'number' THEN
    expected_authority := (identity_facts ->> 'authorityIdentifierRows')::integer;
  END IF;
  IF jsonb_typeof(identity_facts -> 'conflictRows') = 'number' THEN
    expected_conflict := (identity_facts ->> 'conflictRows')::integer;
  END IF;

  IF NEW.icp_id IS DISTINCT FROM parent_icp_id
    OR NEW.terminal_status IS DISTINCT FROM parent_status
    OR NEW.completed_at IS DISTINCT FROM parent_completed_at
    OR NEW.attempted_count IS DISTINCT FROM expected_attempted
    OR NEW.success_count IS DISTINCT FROM expected_success
    OR NEW.zero_result_count IS DISTINCT FROM expected_zero_result
    OR NEW.failure_count IS DISTINCT FROM expected_failure
    OR NEW.failed_run_count IS DISTINCT FROM expected_failed_run
    OR NEW.raw_count IS DISTINCT FROM expected_raw
    OR NEW.duplicate_count IS DISTINCT FROM expected_duplicate
    OR NEW.processed_count IS DISTINCT FROM expected_processed
    OR NEW.accepted_count IS DISTINCT FROM expected_accepted
    OR NEW.bound_count IS DISTINCT FROM expected_bound
    OR NEW.domain_count IS DISTINCT FROM expected_domain
    OR NEW.authority_count IS DISTINCT FROM expected_authority
    OR NEW.conflict_count IS DISTINCT FROM expected_conflict
  THEN
    RAISE EXCEPTION 'provider quality contribution does not match parent run facts';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "provider_quality_contribution_insert_guard"
  BEFORE INSERT ON "provider_quality_run_contribution"
  FOR EACH ROW EXECUTE FUNCTION validate_provider_quality_contribution_insert();

CREATE OR REPLACE FUNCTION reject_provider_quality_contribution_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'provider quality run contributions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "provider_quality_run_contribution_update_guard"
  BEFORE UPDATE ON "provider_quality_run_contribution"
  FOR EACH ROW EXECUTE FUNCTION reject_provider_quality_contribution_mutation();
CREATE TRIGGER "provider_quality_run_contribution_delete_guard"
  BEFORE DELETE ON "provider_quality_run_contribution"
  FOR EACH ROW EXECUTE FUNCTION reject_provider_quality_contribution_mutation();

GRANT SELECT, INSERT ON TABLE "provider_quality_run_contribution" TO app_user;
REVOKE UPDATE, DELETE ON TABLE "provider_quality_run_contribution" FROM app_user;
