BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

CREATE FUNCTION public.discovery_query_providers_valid_v1(p_providers JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  entry JSONB;
  value TEXT;
  prior TEXT;
  count_value INTEGER := 0;
BEGIN
  IF p_providers IS NULL OR jsonb_typeof(p_providers) <> 'array'
    OR jsonb_array_length(p_providers) > 16 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT item FROM jsonb_array_elements(p_providers) item
  LOOP
    IF jsonb_typeof(entry) <> 'string' THEN RETURN false; END IF;
    value := entry #>> '{}';
    IF value !~ '^[a-z][a-z0-9._-]{0,127}$'
      OR prior IS NOT NULL AND value COLLATE "C" <= prior COLLATE "C" THEN
      RETURN false;
    END IF;
    prior := value;
    count_value := count_value + 1;
  END LOOP;
  RETURN count_value = jsonb_array_length(p_providers);
END
$$;

CREATE FUNCTION public.reject_discovery_query_lineage_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'DISCOVERY_QUERY_LINEAGE_IMMUTABLE' USING ERRCODE = 'P0001';
END
$$;

CREATE TABLE public.discovery_query_receipt (
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  plan_id UUID NOT NULL,
  authority_id UUID NOT NULL,
  account_key VARCHAR(200) NOT NULL,
  purpose VARCHAR(64) NOT NULL,
  subject_type VARCHAR(80) NOT NULL,
  subject_id VARCHAR(200) NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  query_key CHAR(64) NOT NULL,
  query_ordinal INTEGER NOT NULL,
  source_class VARCHAR(128) NOT NULL,
  providers JSONB NOT NULL,
  provider_count INTEGER NOT NULL,
  record_count BIGINT NOT NULL,
  accepted_count BIGINT NOT NULL,
  quarantined_count BIGINT NOT NULL,
  rejected_count BIGINT NOT NULL,
  duplicate_count BIGINT NOT NULL,
  governance_denied_count BIGINT NOT NULL,
  usage_quantity BIGINT NOT NULL,
  cost_cents BIGINT NOT NULL,
  contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_query_receipt_pkey
    PRIMARY KEY (workspace_id, run_id, query_key),
  CONSTRAINT discovery_query_receipt_workspace_run_ordinal_key
    UNIQUE (workspace_id, run_id, query_ordinal),
  CONSTRAINT discovery_query_receipt_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.discovery_run(workspace_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_query_receipt_identity_check CHECK (
    purpose='discovery.run'
    AND subject_type='discovery_run'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND subject_id='request:'||request_sha256
    AND account_key=purpose||':'||subject_type||':'||subject_id||':'||request_sha256
    AND query_key ~ '^[0-9a-f]{64}$'
    AND query_ordinal BETWEEN 0 AND 1023
    AND source_class ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    AND contract_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT discovery_query_receipt_provider_check CHECK (
    provider_count=jsonb_array_length(providers)
    AND provider_count BETWEEN 0 AND 16
    AND public.discovery_query_providers_valid_v1(providers)
  ),
  CONSTRAINT discovery_query_receipt_count_check CHECK (
    record_count BETWEEN 0 AND 524160
    AND accepted_count BETWEEN 0 AND 524160
    AND quarantined_count BETWEEN 0 AND 524160
    AND rejected_count BETWEEN 0 AND 524160
    AND duplicate_count BETWEEN 0 AND 524160
    AND governance_denied_count BETWEEN 0 AND 524160
    AND usage_quantity BETWEEN 0 AND 524160
    AND record_count=accepted_count+quarantined_count+rejected_count+duplicate_count
    AND governance_denied_count=quarantined_count+rejected_count
    AND usage_quantity=accepted_count
    AND cost_cents BETWEEN 0 AND 1000000000
  )
);

CREATE TABLE public.discovery_query_operation_attempt (
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  query_key CHAR(64) NOT NULL,
  provider_key VARCHAR(128) NOT NULL,
  producer_id VARCHAR(128) NOT NULL,
  operation_id UUID NOT NULL,
  scope_key VARCHAR(200) NOT NULL,
  authority_id UUID NOT NULL,
  account_id UUID NOT NULL,
  operation_generation INTEGER NOT NULL,
  ack_id CHAR(64) NOT NULL,
  consumer VARCHAR(200) NOT NULL,
  domain_aggregate_type VARCHAR(200) NOT NULL,
  domain_ack_key CHAR(64) NOT NULL,
  domain_revision CHAR(64) NOT NULL,
  result_digest CHAR(64) NOT NULL,
  result_schema VARCHAR(128) NOT NULL,
  lineage_schema VARCHAR(128) NOT NULL,
  provider_record_count INTEGER NOT NULL,
  covered_item_count INTEGER NOT NULL,
  contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_query_operation_attempt_pkey
    PRIMARY KEY (workspace_id, operation_id),
  CONSTRAINT discovery_query_operation_attempt_query_operation_key
    UNIQUE (workspace_id, run_id, query_key, provider_key, operation_id),
  CONSTRAINT discovery_query_operation_attempt_query_fkey
    FOREIGN KEY (workspace_id, run_id, query_key)
    REFERENCES public.discovery_query_receipt(workspace_id, run_id, query_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_query_operation_attempt_operation_fkey
    FOREIGN KEY (scope_key, operation_id)
    REFERENCES public.tool_budget_operation(scope_key, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_query_operation_attempt_ack_fkey
    FOREIGN KEY (ack_id) REFERENCES public.execution_domain_ack(ack_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_query_operation_attempt_identity_check CHECK (
    scope_key=workspace_id::text
    AND provider_key ~ '^[a-z][a-z0-9._-]{0,127}$'
    AND producer_id ~ '^[a-z][a-z0-9._-]{0,127}$'
    AND operation_generation BETWEEN 1 AND 2147483647
    AND ack_id ~ '^[0-9a-f]{64}$'
    AND domain_aggregate_type='RawSourceRecord'
    AND domain_ack_key ~ '^[0-9a-f]{64}$'
    AND domain_revision ~ '^[0-9a-f]{64}$'
    AND result_digest ~ '^[0-9a-f]{64}$'
    AND result_schema ~ '^[a-z][a-z0-9-]{0,99}/v[1-9][0-9]{0,5}$'
    AND lineage_schema='discovery-company-result-lineage/v1'
    AND contract_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT discovery_query_operation_attempt_count_check CHECK (
    provider_record_count BETWEEN 0 AND 1000000
    AND covered_item_count BETWEEN 0 AND LEAST(provider_record_count,4095)
  )
);

CREATE TABLE public.discovery_query_attempt_item (
  id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  query_key CHAR(64) NOT NULL,
  provider_key VARCHAR(128) NOT NULL,
  operation_id UUID NOT NULL,
  record_index INTEGER NOT NULL,
  resolution_kind VARCHAR(32) NOT NULL,
  source_record_index INTEGER,
  raw_record_id UUID NOT NULL,
  raw_payload_hash CHAR(64) NOT NULL,
  raw_ingest_status VARCHAR(32) NOT NULL,
  relation_key VARCHAR(192) NOT NULL,
  operation_subject_id UUID NOT NULL,
  child_subject_id UUID NOT NULL,
  relation_id UUID NOT NULL,
  contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_query_attempt_item_pkey PRIMARY KEY (id),
  CONSTRAINT discovery_query_attempt_item_provider_index_key
    UNIQUE (workspace_id, run_id, query_key, provider_key, record_index),
  CONSTRAINT discovery_query_attempt_item_provider_index_raw_key
    UNIQUE (workspace_id, run_id, query_key, provider_key, record_index, raw_record_id),
  CONSTRAINT discovery_query_attempt_item_operation_relation_key
    UNIQUE (workspace_id, operation_id, relation_key),
  CONSTRAINT discovery_query_attempt_item_attempt_fkey
    FOREIGN KEY (workspace_id, run_id, query_key, provider_key, operation_id)
    REFERENCES public.discovery_query_operation_attempt(
      workspace_id, run_id, query_key, provider_key, operation_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_query_attempt_item_raw_fkey
    FOREIGN KEY (workspace_id, raw_record_id)
    REFERENCES public.raw_source_record(workspace_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_query_attempt_item_source_fkey
    FOREIGN KEY (
      workspace_id, run_id, query_key, provider_key,
      source_record_index, raw_record_id
    ) REFERENCES public.discovery_query_attempt_item(
      workspace_id, run_id, query_key, provider_key,
      record_index, raw_record_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_query_attempt_item_shape_check CHECK (
    record_index BETWEEN 0 AND 999999
    AND resolution_kind IN ('INSERTED','EXISTING','REUSE_BATCH')
    AND raw_payload_hash ~ '^[0-9a-f]{64}$'
    AND raw_ingest_status IN ('ACCEPTED','QUARANTINED','REJECTED')
    AND relation_key='discovery.raw_source_record:'||record_index::text
    AND contract_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      resolution_kind IN ('INSERTED','EXISTING') AND source_record_index IS NULL
      OR resolution_kind='REUSE_BATCH'
        AND source_record_index BETWEEN 0 AND record_index-1
        AND source_record_index < record_index
    )
  )
);

CREATE INDEX discovery_query_receipt_workspace_created_idx
  ON public.discovery_query_receipt(workspace_id, created_at);
CREATE INDEX discovery_query_operation_attempt_query_idx
  ON public.discovery_query_operation_attempt(workspace_id, run_id, query_key);
CREATE INDEX discovery_query_attempt_item_raw_idx
  ON public.discovery_query_attempt_item(workspace_id, raw_record_id);

ALTER TABLE public.discovery_query_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_query_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_query_receipt_workspace ON public.discovery_query_receipt
  USING (workspace_id=public.current_workspace_id())
  WITH CHECK (workspace_id=public.current_workspace_id());

ALTER TABLE public.discovery_query_operation_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_query_operation_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_query_operation_attempt_workspace
  ON public.discovery_query_operation_attempt
  USING (workspace_id=public.current_workspace_id())
  WITH CHECK (workspace_id=public.current_workspace_id());

ALTER TABLE public.discovery_query_attempt_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_query_attempt_item FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_query_attempt_item_workspace ON public.discovery_query_attempt_item
  USING (workspace_id=public.current_workspace_id())
  WITH CHECK (workspace_id=public.current_workspace_id());

CREATE TRIGGER discovery_query_receipt_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_query_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_query_lineage_mutation_v1();
CREATE TRIGGER discovery_query_operation_attempt_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_query_operation_attempt
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_query_lineage_mutation_v1();
CREATE TRIGGER discovery_query_attempt_item_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_query_attempt_item
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_query_lineage_mutation_v1();

REVOKE ALL ON TABLE public.discovery_query_receipt FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_query_receipt FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_query_receipt TO app_user;
REVOKE ALL ON TABLE public.discovery_query_operation_attempt FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_query_operation_attempt FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_query_operation_attempt TO app_user;
REVOKE ALL ON TABLE public.discovery_query_attempt_item FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_query_attempt_item FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_query_attempt_item TO app_user;

REVOKE ALL ON FUNCTION public.discovery_query_providers_valid_v1(JSONB)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.reject_discovery_query_lineage_mutation_v1()
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;

COMMIT;
