BEGIN;

-- discovery query lineage contract v3（2026-11-08）：LINEAGE_DESCRIPTOR.providerContracts 增补四个
-- 结构化直连源（wikidata / openstreetmap / ted / openfda），v2 合同哈希随描述变更：
--   c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c → 7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37
-- v2 命令/回执字段不变，只有合同哈希与进哈希的 providerContracts 内容变化；v1 委托路径的旧哈希
-- （eb5f6f09…）与 raw-relation 哈希（dd2f4144…）保持不变。表级 CHECK 同时接受新旧哈希，
-- 因为 outcome/admission 行不可改写（历史行保留旧哈希），新写入一律新哈希。

ALTER TABLE public.discovery_query_execution_outcome
  DROP CONSTRAINT discovery_query_execution_outcome_contract_check;
ALTER TABLE public.discovery_query_execution_outcome
  ADD CONSTRAINT discovery_query_execution_outcome_contract_check CHECK (
    contract_sha256 IN (
      'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
      '7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37'
    )
  );

ALTER TABLE public.discovery_company_materialization_admission
  DROP CONSTRAINT discovery_company_materialization_admission_shape_check;
ALTER TABLE public.discovery_company_materialization_admission
  ADD CONSTRAINT discovery_company_materialization_admission_shape_check CHECK(
    contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe' AND (
      mode='GOVERNED_C_TX'
      AND materialization_contract_version='discovery-company-materialization/v1'
      AND reason_code='GOVERNED_Q_V2_COMPLETE'
      AND q_contract_sha256 IN ('c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c','7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37')
      OR mode='LEGACY'
      AND materialization_contract_version IS NULL
      AND reason_code='PRE_C_NULL_MARKER'
      AND q_contract_sha256 IS NULL
    )
  );

CREATE OR REPLACE FUNCTION public.append_discovery_query_lineage_v2(p_append_command JSONB)
RETURNS TABLE(status TEXT,attempt_count INTEGER,item_count INTEGER,query_key CHAR(64))
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v1_command JSONB;
  v1_attempts JSONB;
  append_result RECORD;
  lookup_value JSONB;
BEGIN
  IF p_append_command IS NULL OR pg_column_size(p_append_command)>16777216
    OR NOT public.discovery_query_json_keys_exact_v1(p_append_command,ARRAY[
      'schemaVersion','contractSha256','lookup','queryReceipt',
      'queryReceiptContractSha256','rawRelationContractSha256','budgetTruncated',
      'attempts','items','authorization'])
    OR p_append_command->>'schemaVersion'<>'discovery-query-lineage-command/v2'
    OR p_append_command->>'contractSha256'<>
      '7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37'
    OR p_append_command->>'queryReceiptContractSha256'<>
      '7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37'
    OR p_append_command->>'rawRelationContractSha256'<>
      'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1'
    OR jsonb_typeof(p_append_command->'budgetTruncated')<>'boolean'
    OR jsonb_typeof(p_append_command->'attempts')<>'array'
    OR EXISTS(
      SELECT 1
      FROM jsonb_array_elements(p_append_command->'attempts') attempt
      WHERE jsonb_typeof(attempt)<>'object'
        OR attempt->>'contractSha256'<>
          '7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37'
    )
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_set(attempt,'{contractSha256}',
      to_jsonb('eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0'::text),false)
    ORDER BY attempt->>'operationId'), '[]'::jsonb)
  INTO v1_attempts
  FROM jsonb_array_elements(p_append_command->'attempts') attempt;

  v1_command:=p_append_command-'budgetTruncated';
  v1_command:=jsonb_set(v1_command,'{schemaVersion}',
    to_jsonb('discovery-query-lineage-command/v1'::text),false);
  v1_command:=jsonb_set(v1_command,'{contractSha256}',
    to_jsonb('eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0'::text),false);
  v1_command:=jsonb_set(v1_command,'{queryReceiptContractSha256}',
    to_jsonb('eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0'::text),false);
  v1_command:=jsonb_set(v1_command,'{attempts}',v1_attempts,false);

  SELECT * INTO STRICT append_result
  FROM public.append_discovery_query_lineage_v1(v1_command);
  IF append_result.status<>'APPLIED' THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE' USING ERRCODE='P0001';
  END IF;
  lookup_value:=p_append_command->'lookup';
  INSERT INTO public.discovery_query_execution_outcome(
    workspace_id,run_id,query_key,budget_truncated,contract_sha256)
  VALUES(
    (lookup_value->>'workspaceId')::uuid,
    (lookup_value->>'runId')::uuid,
    (lookup_value->>'queryKey')::char(64),
    (p_append_command->>'budgetTruncated')::boolean,
    p_append_command->>'contractSha256');

  RETURN QUERY SELECT append_result.status::text,
    append_result.attempt_count::integer,append_result.item_count::integer,
    append_result.query_key::char(64);
EXCEPTION
  WHEN data_exception THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001';
END
$$;



CREATE OR REPLACE FUNCTION public.attest_discovery_query_lineage_v2(p_attestation_key JSONB)
RETURNS TABLE(status TEXT,query_receipt JSONB,budget_truncated BOOLEAN,
  attempt_count INTEGER,item_count INTEGER,replay BOOLEAN)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  attest_result RECORD;
  outcome_value BOOLEAN;
  outcome_count INTEGER;
BEGIN
  SELECT * INTO STRICT attest_result
  FROM public.attest_discovery_query_lineage_v1(p_attestation_key);
  IF attest_result.status='NOT_FOUND' THEN
    RETURN QUERY SELECT 'NOT_FOUND',NULL::jsonb,NULL::boolean,0,0,false;
    RETURN;
  END IF;
  IF attest_result.status<>'REPLAYED' OR attest_result.replay IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD'
      USING ERRCODE='P0001';
  END IF;
  SELECT count(*),bool_or(outcome.budget_truncated)
  INTO outcome_count,outcome_value
  FROM public.discovery_query_execution_outcome outcome
  WHERE outcome.workspace_id=(p_attestation_key->>'workspaceId')::uuid
    AND outcome.run_id=(p_attestation_key->>'runId')::uuid
    AND outcome.query_key=(p_attestation_key->>'queryKey')::char(64)
    AND outcome.contract_sha256=
      '7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37';
  IF outcome_count<>1 OR outcome_value IS NULL THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD'
      USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT attest_result.status::text,attest_result.query_receipt::jsonb,
    outcome_value,attest_result.attempt_count::integer,
    attest_result.item_count::integer,attest_result.replay::boolean;
EXCEPTION
  WHEN data_exception THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001';
END
$$;

CREATE OR REPLACE FUNCTION public.admit_discovery_company_materialization_v1(p_identity JSONB)
RETURNS TABLE(status TEXT,admission_id UUID,mode TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $body$
DECLARE identity_row RECORD; run_row public.discovery_run%ROWTYPE;
  existing public.discovery_company_materialization_admission%ROWTYPE;
  expected_queries INTEGER; q_receipts INTEGER; q_outcomes INTEGER; c_state BIGINT;
BEGIN
  SELECT * INTO identity_row FROM public._discovery_company_materialization_identity_v1(
    p_identity,false,false);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'discovery-company-materialization-run:'||identity_row.workspace_id||':'||identity_row.run_id,0));
  SELECT * INTO run_row FROM public.discovery_run run
    WHERE run.workspace_id=identity_row.workspace_id AND run.id=identity_row.run_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  SELECT * INTO existing FROM public.discovery_company_materialization_admission admission
    WHERE admission.workspace_id=identity_row.workspace_id AND admission.run_id=identity_row.run_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'REPLAYED'::TEXT,existing.admission_id,existing.mode::TEXT;
    RETURN;
  END IF;
  SELECT count(*) INTO c_state FROM (
    SELECT run_id FROM public.discovery_company_materialization_outcome
      WHERE workspace_id=identity_row.workspace_id AND run_id=identity_row.run_id
    UNION ALL SELECT run_id FROM public.discovery_company_materialization_batch_receipt
      WHERE workspace_id=identity_row.workspace_id AND run_id=identity_row.run_id
    UNION ALL SELECT run_id FROM public.discovery_company_materialization_query_receipt
      WHERE workspace_id=identity_row.workspace_id AND run_id=identity_row.run_id
    UNION ALL SELECT run_id FROM public.discovery_company_materialization_run_receipt
      WHERE workspace_id=identity_row.workspace_id AND run_id=identity_row.run_id) state;
  IF c_state<>0 THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
    USING ERRCODE='P0001'; END IF;
  IF run_row.materialization_contract_version IS NULL THEN
    INSERT INTO public.discovery_company_materialization_admission(
      workspace_id,run_id,materialization_contract_version,mode,reason_code,
      q_contract_sha256,contract_sha256)
    VALUES(identity_row.workspace_id,identity_row.run_id,NULL,'LEGACY','PRE_C_NULL_MARKER',NULL,
      '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe')
    RETURNING discovery_company_materialization_admission.admission_id INTO admission_id;
    status:='APPLIED'; mode:='LEGACY'; RETURN NEXT; RETURN;
  END IF;
  IF run_row.materialization_contract_version<>'discovery-company-materialization/v1'
    OR NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_activation activation
      WHERE activation.activation_id=1
        AND activation.contract_version='discovery-company-materialization/v1'
        AND activation.contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe')
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_UNAVAILABLE'
    USING ERRCODE='P0001'; END IF;
  SELECT jsonb_array_length(plan.queries) INTO expected_queries
    FROM public.discovery_query_plan plan WHERE plan.id=run_row.plan_id;
  SELECT count(*) INTO q_receipts FROM public.discovery_query_receipt receipt
    WHERE receipt.workspace_id=identity_row.workspace_id AND receipt.run_id=identity_row.run_id;
  SELECT count(*) INTO q_outcomes FROM public.discovery_query_execution_outcome outcome
    WHERE outcome.workspace_id=identity_row.workspace_id AND outcome.run_id=identity_row.run_id;
  IF expected_queries IS NULL OR q_receipts<>expected_queries OR q_outcomes<>expected_queries
    OR EXISTS(SELECT 1 FROM generate_series(0,expected_queries-1) ordinal
      WHERE NOT EXISTS(SELECT 1 FROM public.discovery_query_receipt receipt
        WHERE receipt.workspace_id=identity_row.workspace_id AND receipt.run_id=identity_row.run_id
          AND receipt.query_ordinal=ordinal))
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
    USING ERRCODE='P0001'; END IF;
  INSERT INTO public.discovery_company_materialization_admission(
    workspace_id,run_id,materialization_contract_version,mode,reason_code,
    q_contract_sha256,contract_sha256)
  VALUES(identity_row.workspace_id,identity_row.run_id,'discovery-company-materialization/v1',
    'GOVERNED_C_TX','GOVERNED_Q_V2_COMPLETE',
    '7b29dc8ff4fa261f3dd79dc593b0ef88b4080a62083be5867a4c221c82bf0f37',
    '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe')
  RETURNING discovery_company_materialization_admission.admission_id INTO admission_id;
  status:='APPLIED'; mode:='GOVERNED_C_TX'; RETURN NEXT;
END $body$;

GRANT EXECUTE ON FUNCTION public.append_discovery_query_lineage_v2(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.attest_discovery_query_lineage_v2(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.admit_discovery_company_materialization_v1(JSONB) TO app_user;

COMMIT;
