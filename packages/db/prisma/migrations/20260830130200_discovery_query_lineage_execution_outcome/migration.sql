BEGIN;

CREATE TABLE public.discovery_query_execution_outcome (
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  query_key CHAR(64) NOT NULL,
  budget_truncated BOOLEAN NOT NULL,
  contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_query_execution_outcome_pkey
    PRIMARY KEY (workspace_id, run_id, query_key),
  CONSTRAINT discovery_query_execution_outcome_receipt_fkey
    FOREIGN KEY (workspace_id, run_id, query_key)
    REFERENCES public.discovery_query_receipt(workspace_id, run_id, query_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_query_execution_outcome_contract_check CHECK (
    contract_sha256='c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c'
  )
);

CREATE INDEX discovery_query_execution_outcome_workspace_created_idx
  ON public.discovery_query_execution_outcome(workspace_id, created_at);

ALTER TABLE public.discovery_query_execution_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_query_execution_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_query_execution_outcome_workspace
  ON public.discovery_query_execution_outcome
  USING (workspace_id=public.current_workspace_id())
  WITH CHECK (workspace_id=public.current_workspace_id());

CREATE TRIGGER discovery_query_execution_outcome_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_query_execution_outcome
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_query_lineage_mutation_v1();

REVOKE ALL ON TABLE public.discovery_query_execution_outcome FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_query_execution_outcome FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_query_execution_outcome TO app_user;

CREATE FUNCTION public.append_discovery_query_lineage_v2(p_append_command JSONB)
RETURNS TABLE(status TEXT,attempt_count INTEGER,item_count INTEGER,query_key CHAR(64))
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
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
      'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c'
    OR p_append_command->>'queryReceiptContractSha256'<>
      'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c'
    OR p_append_command->>'rawRelationContractSha256'<>
      'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1'
    OR jsonb_typeof(p_append_command->'budgetTruncated')<>'boolean'
    OR jsonb_typeof(p_append_command->'attempts')<>'array'
    OR EXISTS(
      SELECT 1
      FROM jsonb_array_elements(p_append_command->'attempts') attempt
      WHERE jsonb_typeof(attempt)<>'object'
        OR attempt->>'contractSha256'<>
          'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c'
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

CREATE FUNCTION public.attest_discovery_query_lineage_v2(p_attestation_key JSONB)
RETURNS TABLE(status TEXT,query_receipt JSONB,budget_truncated BOOLEAN,
  attempt_count INTEGER,item_count INTEGER,replay BOOLEAN)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
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
      'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c';
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

REVOKE ALL ON FUNCTION public.append_discovery_query_lineage_v2(JSONB)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.attest_discovery_query_lineage_v2(JSONB)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION public.append_discovery_query_lineage_v2(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.attest_discovery_query_lineage_v2(JSONB) TO app_user;

COMMIT;
