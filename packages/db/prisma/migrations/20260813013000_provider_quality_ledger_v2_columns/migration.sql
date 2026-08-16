-- Forward-only compatibility upgrade for experiment databases that applied an
-- earlier draft of the provider quality ledger before the additive execution
-- counters were finalized. On a clean database the preceding migration has
-- already created these columns and this migration is intentionally a no-op
-- for the ADD COLUMN steps.

BEGIN;

-- Migration owners are not guaranteed to be superusers. Disable RLS only for
-- this locked schema upgrade so complete historical rows are visible to the
-- parity checks/backfill; the tenant policy is recreated and FORCE restored
-- before COMMIT.
ALTER TABLE "provider_quality_run_contribution" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "provider_quality_run_contribution"
  ADD COLUMN IF NOT EXISTS "attempted_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "success_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "zero_result_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "failed_run_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "processed_count" INTEGER;

-- Old ledgers are immutable. Temporarily remove only the UPDATE guard inside
-- this transactional migration, then restore it before privileges/RLS are
-- reasserted below. DELETE protection remains active throughout.
DROP TRIGGER IF EXISTS "provider_quality_run_contribution_update_guard"
  ON "provider_quality_run_contribution";

-- Never guess historical execution facts. An old contribution is upgradeable
-- only when its terminal parent run contains all eight provider counters.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "provider_quality_run_contribution" contribution
      JOIN "discovery_run" run
        ON run."workspace_id" = contribution."workspace_id"
       AND run."id" = contribution."run_id"
     WHERE (
       contribution."attempted_count" IS NULL OR
       contribution."success_count" IS NULL OR
       contribution."zero_result_count" IS NULL OR
       contribution."failed_run_count" IS NULL OR
       contribution."processed_count" IS NULL
     )
       AND (
         jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key") = 'object'
         AND jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key" -> 'attemptedCount') = 'number'
         AND jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key" -> 'successCount') = 'number'
         AND jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key" -> 'zeroResultCount') = 'number'
         AND jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key" -> 'failureCount') = 'number'
         AND jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key" -> 'rawCount') = 'number'
         AND jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key" -> 'quarantinedCount') = 'number'
         AND jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key" -> 'rejectedCount') = 'number'
         AND jsonb_typeof(run."stats" -> 'perProvider' -> contribution."provider_key" -> 'duplicateCount') = 'number'
       ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'provider quality v2 migration cannot reconstruct incomplete historical facts';
  END IF;
END;
$$;

-- Old draft rows were writable by INSERT before the parent-fact guard existed.
-- Reject any row whose immutable identity/terminal facts do not match its
-- parent run, or whose optional identity counts disagree with available facts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "provider_quality_run_contribution" contribution
      JOIN "discovery_run" run
        ON run."workspace_id" = contribution."workspace_id"
       AND run."id" = contribution."run_id"
     WHERE run."status" NOT IN ('DONE', 'PARTIAL', 'FAILED')
        OR run."completed_at" IS NULL
        OR contribution."icp_id" IS DISTINCT FROM run."icp_id"
        OR contribution."terminal_status" IS DISTINCT FROM run."status"
        OR contribution."completed_at" IS DISTINCT FROM run."completed_at"
        OR contribution."accepted_count" IS DISTINCT FROM CASE
          WHEN jsonb_typeof(run."stats" -> 'identityQuality' -> contribution."provider_key" -> 'acceptedRows') = 'number'
          THEN (run."stats" -> 'identityQuality' -> contribution."provider_key" ->> 'acceptedRows')::integer
          ELSE NULL END
        OR contribution."bound_count" IS DISTINCT FROM CASE
          WHEN jsonb_typeof(run."stats" -> 'identityQuality' -> contribution."provider_key" -> 'boundRows') = 'number'
          THEN (run."stats" -> 'identityQuality' -> contribution."provider_key" ->> 'boundRows')::integer
          ELSE NULL END
        OR contribution."domain_count" IS DISTINCT FROM CASE
          WHEN jsonb_typeof(run."stats" -> 'identityQuality' -> contribution."provider_key" -> 'domainRows') = 'number'
          THEN (run."stats" -> 'identityQuality' -> contribution."provider_key" ->> 'domainRows')::integer
          ELSE NULL END
        OR contribution."authority_count" IS DISTINCT FROM CASE
          WHEN jsonb_typeof(run."stats" -> 'identityQuality' -> contribution."provider_key" -> 'authorityIdentifierRows') = 'number'
          THEN (run."stats" -> 'identityQuality' -> contribution."provider_key" ->> 'authorityIdentifierRows')::integer
          ELSE NULL END
        OR contribution."conflict_count" IS DISTINCT FROM CASE
          WHEN jsonb_typeof(run."stats" -> 'identityQuality' -> contribution."provider_key" -> 'conflictRows') = 'number'
          THEN (run."stats" -> 'identityQuality' -> contribution."provider_key" ->> 'conflictRows')::integer
          ELSE NULL END
  ) THEN
    RAISE EXCEPTION 'provider quality v2 migration found a historical row inconsistent with parent run facts';
  END IF;
END;
$$;

UPDATE "provider_quality_run_contribution" contribution
   SET "attempted_count" = (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'attemptedCount')::integer,
       "success_count" = (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'successCount')::integer,
       "zero_result_count" = (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'zeroResultCount')::integer,
       "failure_count" = (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'failureCount')::integer,
       "failed_run_count" = CASE WHEN (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'failureCount')::integer > 0 THEN 1 ELSE 0 END,
       "raw_count" = (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'rawCount')::integer,
       "duplicate_count" = (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'duplicateCount')::integer,
       "processed_count" =
         (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'rawCount')::integer +
         (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'quarantinedCount')::integer +
         (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'rejectedCount')::integer +
         (run."stats" -> 'perProvider' -> contribution."provider_key" ->> 'duplicateCount')::integer
  FROM "discovery_run" run
 WHERE run."workspace_id" = contribution."workspace_id"
   AND run."id" = contribution."run_id"
   AND (
     contribution."attempted_count" IS NULL OR
     contribution."success_count" IS NULL OR
     contribution."zero_result_count" IS NULL OR
     contribution."failed_run_count" IS NULL OR
     contribution."processed_count" IS NULL
   );

ALTER TABLE "provider_quality_run_contribution"
  ALTER COLUMN "raw_count" SET NOT NULL,
  ALTER COLUMN "failure_count" SET NOT NULL,
  ALTER COLUMN "duplicate_count" SET NOT NULL,
  ALTER COLUMN "attempted_count" SET NOT NULL,
  ALTER COLUMN "success_count" SET NOT NULL,
  ALTER COLUMN "zero_result_count" SET NOT NULL,
  ALTER COLUMN "failed_run_count" SET NOT NULL,
  ALTER COLUMN "processed_count" SET NOT NULL;

ALTER TABLE "provider_quality_run_contribution"
  DROP CONSTRAINT IF EXISTS "provider_quality_run_contribution_nonnegative_counts_check",
  DROP CONSTRAINT IF EXISTS "provider_quality_run_contribution_provider_key_check",
  DROP CONSTRAINT IF EXISTS "provider_quality_run_contribution_attempt_accounting_check",
  DROP CONSTRAINT IF EXISTS "provider_quality_run_contribution_row_accounting_check",
  DROP CONSTRAINT IF EXISTS "provider_quality_run_contribution_identity_accounting_check";

ALTER TABLE "provider_quality_run_contribution"
  ADD CONSTRAINT "provider_quality_run_contribution_provider_key_check"
    CHECK (length(btrim("provider_key")) BETWEEN 1 AND 128 AND "provider_key" = btrim("provider_key") AND position('+' in "provider_key") = 0),
  ADD CONSTRAINT "provider_quality_run_contribution_attempt_accounting_check"
    CHECK (
      "attempted_count" >= 1 AND
      "success_count" >= 0 AND
      "failure_count" >= 0 AND
      "success_count" + "failure_count" = "attempted_count" AND
      "zero_result_count" BETWEEN 0 AND "success_count" AND
      "failed_run_count" IN (0, 1) AND
      "failed_run_count" = CASE WHEN "failure_count" > 0 THEN 1 ELSE 0 END
    ),
  ADD CONSTRAINT "provider_quality_run_contribution_row_accounting_check"
    CHECK (
      "processed_count" >= 0 AND
      "raw_count" >= 0 AND
      "duplicate_count" >= 0 AND
      "duplicate_count" <= "processed_count"
    ),
  ADD CONSTRAINT "provider_quality_run_contribution_identity_accounting_check"
    CHECK (
      ("accepted_count" IS NULL OR "accepted_count" >= 0) AND
      ("bound_count" IS NULL OR ("bound_count" >= 0 AND "accepted_count" IS NOT NULL AND "bound_count" <= "accepted_count")) AND
      ("domain_count" IS NULL OR ("domain_count" >= 0 AND "accepted_count" IS NOT NULL AND "domain_count" <= "accepted_count")) AND
      ("authority_count" IS NULL OR ("authority_count" >= 0 AND "accepted_count" IS NOT NULL AND "authority_count" <= "accepted_count")) AND
      ("conflict_count" IS NULL OR ("conflict_count" >= 0 AND "accepted_count" IS NOT NULL AND "conflict_count" <= "accepted_count"))
    );

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
  expected_failed_run := CASE WHEN expected_failure > 0 THEN 1 ELSE 0 END;

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

DROP TRIGGER IF EXISTS "provider_quality_contribution_insert_guard"
  ON "provider_quality_run_contribution";
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
DROP TRIGGER IF EXISTS "provider_quality_run_contribution_delete_guard"
  ON "provider_quality_run_contribution";
CREATE TRIGGER "provider_quality_run_contribution_delete_guard"
  BEFORE DELETE ON "provider_quality_run_contribution"
  FOR EACH ROW EXECUTE FUNCTION reject_provider_quality_contribution_mutation();

ALTER TABLE "provider_quality_run_contribution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_quality_run_contribution" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "provider_quality_run_contribution_tenant_isolation"
  ON "provider_quality_run_contribution";
CREATE POLICY "provider_quality_run_contribution_tenant_isolation"
  ON "provider_quality_run_contribution"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT ON TABLE "provider_quality_run_contribution" TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "provider_quality_run_contribution" FROM app_user;

COMMIT;
