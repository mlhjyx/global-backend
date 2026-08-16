\set ON_ERROR_STOP on

INSERT INTO discovery_run (id, workspace_id, plan_id, icp_id, status, stats, completed_at)
VALUES
  (
    '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000000a',
    '10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000021', 'DONE',
    '{"perProvider":{"sql_acceptance":{"attemptedCount":1,"successCount":1,"zeroResultCount":0,"failureCount":0,"rawCount":0,"quarantinedCount":0,"rejectedCount":0,"duplicateCount":8}},"identityQuality":{}}',
    '2026-08-13T00:00:00.000Z'
  ),
  (
    '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-00000000000b',
    '10000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000022', 'DONE',
    '{"perProvider":{"other":{"attemptedCount":1,"successCount":1,"zeroResultCount":1,"failureCount":0,"rawCount":0,"quarantinedCount":0,"rejectedCount":0,"duplicateCount":0}},"identityQuality":{}}',
    '2026-08-13T00:00:00.000Z'
  ),
  (
    '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-00000000000a',
    '10000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000023', 'RUNNING',
    '{"perProvider":{"preoccupy":{"attemptedCount":1,"successCount":0,"zeroResultCount":0,"failureCount":1,"rawCount":0,"quarantinedCount":0,"rejectedCount":0,"duplicateCount":0}},"identityQuality":{}}',
    NULL
  );

SET ROLE app_user;
SELECT set_config('app.current_workspace_id', '10000000-0000-4000-8000-00000000000a', false);

INSERT INTO provider_quality_run_contribution (
  id, workspace_id, run_id, icp_id, provider_key, terminal_status,
  attempted_count, success_count, zero_result_count, failure_count, failed_run_count,
  processed_count, raw_count, accepted_count, bound_count, domain_count, authority_count,
  conflict_count, duplicate_count, completed_at
) VALUES (
  '10000000-0000-4000-8000-000000000031',
  '10000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000021', 'sql_acceptance', 'DONE',
  1, 1, 0, 0, 0, 8, 0, NULL, NULL, NULL, NULL, NULL, 8, '2026-08-13T00:00:00.000Z'
)
ON CONFLICT (workspace_id, run_id, provider_key) DO NOTHING;

-- Same delivery is idempotent and the all-duplicate denominator remains 8.
INSERT INTO provider_quality_run_contribution (
  id, workspace_id, run_id, icp_id, provider_key, terminal_status,
  attempted_count, success_count, zero_result_count, failure_count, failed_run_count,
  processed_count, raw_count, duplicate_count, completed_at
) VALUES (
  '10000000-0000-4000-8000-000000000032',
  '10000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000021', 'sql_acceptance', 'DONE',
  1, 1, 0, 0, 0, 8, 0, 8, '2026-08-13T00:00:00.000Z'
)
ON CONFLICT (workspace_id, run_id, provider_key) DO NOTHING;

DO $$
DECLARE visible_rows integer; processed integer; duplicates integer;
BEGIN
  SELECT count(*), max(processed_count), max(duplicate_count)
    INTO visible_rows, processed, duplicates
    FROM provider_quality_run_contribution
   WHERE run_id = '10000000-0000-4000-8000-000000000001';
  IF visible_rows <> 1 OR processed <> 8 OR duplicates <> 8 THEN
    RAISE EXCEPTION 'idempotency or duplicate denominator failed';
  END IF;
END $$;

-- An app caller cannot preoccupy a RUNNING run's unique key.
DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO provider_quality_run_contribution (
      workspace_id, run_id, icp_id, provider_key, terminal_status,
      attempted_count, success_count, zero_result_count, failure_count, failed_run_count,
      processed_count, raw_count, duplicate_count, completed_at
    ) VALUES (
      '10000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000023', 'preoccupy', 'DONE',
      1, 0, 0, 1, 1, 0, 0, 0, '2026-08-13T00:00:00.000Z'
    );
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'preoccupation unexpectedly succeeded'; END IF;
END $$;

-- A wrong counter cannot reserve a terminal run's key either.
DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO provider_quality_run_contribution (
      workspace_id, run_id, icp_id, provider_key, terminal_status,
      attempted_count, success_count, zero_result_count, failure_count, failed_run_count,
      processed_count, raw_count, duplicate_count, completed_at
    ) VALUES (
      '10000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000021', 'sql_acceptance', 'DONE',
      1, 1, 0, 0, 0, 99, 0, 99, '2026-08-13T00:00:00.000Z'
    );
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'fact drift unexpectedly succeeded'; END IF;
END $$;

DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    UPDATE provider_quality_run_contribution SET raw_count = 99
    WHERE run_id = '10000000-0000-4000-8000-000000000001';
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'immutable update unexpectedly succeeded'; END IF;
END $$;

SELECT set_config('app.current_workspace_id', '10000000-0000-4000-8000-00000000000b', false);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_quality_run_contribution WHERE run_id = '10000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'workspace B saw workspace A rows';
  END IF;
END $$;

RESET app.current_workspace_id;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_quality_run_contribution) THEN
    RAISE EXCEPTION 'unset workspace saw tenant rows';
  END IF;
END $$;

RESET ROLE;
SELECT 'PROVIDER_QUALITY_LEDGER_RLS_PASS' AS result;
