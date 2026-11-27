BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.discovery_v3_manufacturer_evidence (
  workspace_id uuid NOT NULL,
  company_id uuid NOT NULL,
  run_id uuid NOT NULL,
  lookup_operation_id uuid NOT NULL,
  fetch_operation_id uuid NOT NULL,
  lookup_result_sha256 varchar(64) NOT NULL CHECK (lookup_result_sha256 ~ '^[0-9a-f]{64}$'),
  fetch_result_sha256 varchar(64) NOT NULL CHECK (fetch_result_sha256 ~ '^[0-9a-f]{64}$'),
  consumer_sha256 varchar(64) NOT NULL CHECK (consumer_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_id uuid NOT NULL UNIQUE REFERENCES public.generic_operation_artifact(id) ON DELETE CASCADE,
  evidence jsonb NOT NULL CHECK (public.manufacturer_network_evidence_valid_v1(evidence)),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, company_id, run_id),
  CONSTRAINT discovery_v3_manufacturer_company_fkey FOREIGN KEY (workspace_id, company_id) REFERENCES public.canonical_company(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT discovery_v3_manufacturer_run_fkey FOREIGN KEY (workspace_id, run_id) REFERENCES public.discovery_run(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT discovery_v3_manufacturer_lookup_fkey FOREIGN KEY (workspace_id, lookup_operation_id) REFERENCES public.discovery_v3_operation(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT discovery_v3_manufacturer_fetch_fkey FOREIGN KEY (workspace_id, fetch_operation_id) REFERENCES public.discovery_v3_operation(workspace_id, id) ON DELETE CASCADE,
  CHECK (lookup_operation_id <> fetch_operation_id)
);

CREATE INDEX discovery_v3_manufacturer_evidence_run_idx ON public.discovery_v3_manufacturer_evidence(workspace_id, run_id);
ALTER TABLE public.discovery_v3_manufacturer_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_v3_manufacturer_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_v3_manufacturer_evidence_workspace ON public.discovery_v3_manufacturer_evidence
  USING (workspace_id = nullif(current_setting('app.current_workspace_id',true),'')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id',true),'')::uuid);
REVOKE ALL ON public.discovery_v3_manufacturer_evidence FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_platform_worker, runtime_outbox_relay;
GRANT SELECT ON public.discovery_v3_manufacturer_evidence TO app_user;

CREATE FUNCTION public.enforce_discovery_v3_manufacturer_ack_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM public.discovery_v3_operation op
      WHERE op.workspace_id=NEW.workspace_id AND op.run_id=NEW.run_id AND op.status='SUCCEEDED'
        AND op.ack=NEW.consumer_sha256 AND ((op.id=NEW.lookup_operation_id AND op.result_sha256=NEW.lookup_result_sha256)
        OR (op.id=NEW.fetch_operation_id AND op.result_sha256=NEW.fetch_result_sha256))) <> 2
  THEN RAISE EXCEPTION 'DISCOVERY_V3_MANUFACTURER_ACK_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER discovery_v3_manufacturer_ack_guard
  AFTER INSERT ON public.discovery_v3_manufacturer_evidence DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_discovery_v3_manufacturer_ack_v1();

CREATE FUNCTION public.commit_discovery_v3_manufacturer_evidence_v1(
  w uuid, c uuid, r uuid, request_digest text, worker_attempt integer,
  lookup_id uuid, lookup_digest text, fetch_id uuid, fetch_digest text, consumer_digest text, e jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  admitted public.discovery_run;
  company public.canonical_company;
  lookup public.discovery_v3_operation;
  fetched public.discovery_v3_operation;
  artifact public.generic_operation_artifact;
  previous public.discovery_v3_manufacturer_evidence;
  config jsonb;
  publisher jsonb;
  independent jsonb;
  policy public.source_policy;
  checked_at timestamptz := clock_timestamp();
  source_host text := substring(e->>'sourceUrl' from '^https://([^/]+)/');
  source_path text := regexp_replace(e->>'sourceUrl', '^https://[^/]+', '');
BEGIN
  IF w IS DISTINCT FROM nullif(current_setting('app.current_workspace_id',true),'')::uuid
    OR NOT public.manufacturer_network_evidence_valid_v1(e) OR e->>'workspaceId' IS DISTINCT FROM w::text
    OR e->>'companyId' IS DISTINCT FROM c::text OR e->>'operationId' IS DISTINCT FROM fetch_id::text
  THEN RAISE EXCEPTION 'DISCOVERY_V3_MANUFACTURER_SCOPE_INVALID'; END IF;

  SELECT * INTO admitted FROM public.discovery_run WHERE workspace_id=w AND id=r FOR UPDATE;
  IF NOT FOUND OR admitted.execution_contract_version <> 3 OR admitted.status <> 'RUNNING'
    OR admitted.v3_worker_accepted_at IS NULL OR admitted.v3_worker_attempt IS DISTINCT FROM worker_attempt
    OR admitted.v3_request_sha256 IS DISTINCT FROM request_digest
    OR admitted.v3_manufacturer_revision IS NULL
    OR jsonb_typeof(admitted.v3_plan_queries) IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'DISCOVERY_V3_MANUFACTURER_SCOPE_INVALID'; END IF;
  IF jsonb_array_length(admitted.v3_plan_queries)=0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(admitted.v3_plan_queries) query
    WHERE query#>>'{filters,procurement_scenario}' IS DISTINCT FROM 'distribution'
  ) THEN RAISE EXCEPTION 'DISCOVERY_V3_MANUFACTURER_SCOPE_INVALID'; END IF;

  SELECT * INTO company FROM public.canonical_company WHERE workspace_id=w AND id=c FOR UPDATE;
  IF NOT FOUND OR company.status='SUPPRESSED' THEN RETURN false; END IF;
  IF company.country IS DISTINCT FROM 'DE' OR regexp_replace(company.domain, '^www\.', '') IS DISTINCT FROM e->>'targetDomain'
    OR company.name IS DISTINCT FROM e->>'targetName' THEN RAISE EXCEPTION 'DISCOVERY_V3_MANUFACTURER_SUBJECT_INVALID'; END IF;
  IF EXISTS (SELECT 1 FROM public.generic_operation_artifact_subject_tombstone
    WHERE workspace_id=w AND subject_type='company' AND subject_id=c) THEN RETURN false; END IF;

  SELECT * INTO lookup FROM public.discovery_v3_operation WHERE workspace_id=w AND run_id=r AND id=lookup_id
    AND kind='TOOL' AND action='searxng.search' AND provider=action AND method='invoke'
    AND step='manufacturer/'||c::text||'/tool/1' AND ordinal=1 AND status='SUCCEEDED' AND result_sha256=lookup_digest;
  SELECT * INTO fetched FROM public.discovery_v3_operation WHERE workspace_id=w AND run_id=r AND id=fetch_id
    AND kind='TOOL' AND action='crawl4ai.fetch' AND provider=action AND method='invoke'
    AND step='manufacturer/'||c::text||'/tool/2' AND ordinal=1 AND status='SUCCEEDED' AND result_sha256=fetch_digest;
  SELECT * INTO artifact FROM public.generic_operation_artifact WHERE workspace_id=w AND id=(e->>'artifactId')::uuid
    AND execution_contract_version=3 AND discovery_v3_operation_id=fetch_id AND result_schema='crawl4ai-fetch/v1';
  IF lookup.id IS NULL OR fetched.id IS NULL OR artifact.id IS NULL
    OR lookup.result->>'schema' IS DISTINCT FROM 'searxng-search/v1' OR fetched.result->>'schema' IS DISTINCT FROM 'discovery-v3-artifact-reference/v1'
    OR public.discovery_v3_artifact_reference_v1(artifact) IS DISTINCT FROM fetched.result->'data'
    OR artifact.sha256 IS DISTINCT FROM e->>'resultDigest' OR artifact.expected_content_hash IS DISTINCT FROM e->>'contentHash'
    OR artifact.expected_sanitized_url IS DISTINCT FROM e->>'sourceUrl' OR artifact.created_at IS DISTINCT FROM (e->>'fetchedAt')::timestamptz
    OR artifact.expires_at < (e->>'expiresAt')::timestamptz OR (e->>'expiresAt')::timestamptz <= checked_at
    OR NOT EXISTS (SELECT 1 FROM public.generic_operation_artifact_subject s
      WHERE s.workspace_id=w AND s.artifact_id=artifact.id AND s.subject_type='company' AND s.subject_id=c)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(lookup.result#>'{data,data,data,results}') hit WHERE hit->>'url'=e->>'sourceUrl')
  THEN RAISE EXCEPTION 'DISCOVERY_V3_MANUFACTURER_RECEIPT_INVALID'; END IF;

  SELECT data_provider.config INTO config FROM public.data_provider WHERE key='manufacturer_network' AND status='ENABLED' FOR SHARE;
  IF config->>'schemaVersion' IS DISTINCT FROM 'manufacturer-network-sources/v1' THEN RETURN false; END IF;
  SELECT value INTO publisher FROM jsonb_array_elements(config->'sources') WHERE value->>'publisherId'=e->>'publisherId'
    AND value->>'reviewRef'=e->>'sourceReviewRef' AND value->>'licenseLabel'=e->>'licenseLabel'
    AND (value->>'reviewedAt')::timestamptz<=checked_at AND (value->>'expiresAt')::timestamptz>checked_at;
  SELECT value INTO independent FROM jsonb_array_elements(config->'independenceAttestations') WHERE value->>'publisherId'=e->>'publisherId'
    AND value->>'workspaceId'=w::text AND value->>'companyId'=c::text AND value->>'targetDomain'=e->>'targetDomain'
    AND value->>'reviewRef'=e->>'independenceReviewRef' AND jsonb_array_length(value->'independenceBasisRefs')>0
    AND (value->>'reviewedAt')::timestamptz<=checked_at AND (value->>'expiresAt')::timestamptz>checked_at;
  SELECT * INTO policy FROM public.source_policy WHERE domain=source_host OR right(source_host,length(domain)+1)='.'||domain
    ORDER BY length(domain) DESC LIMIT 1 FOR SHARE;
  IF publisher IS NULL OR independent IS NULL OR policy.id IS DISTINCT FROM (e->>'sourcePolicyId')::uuid
    OR source_host NOT IN (publisher->>'domain','www.'||(publisher->>'domain')) OR policy.domain NOT IN (source_host,publisher->>'domain')
    OR policy.review_status<>'APPROVED' OR policy.source_type<>'official_website' OR policy.terms_status NOT IN ('REVIEWED_OK','REVIEWED_RESTRICTED')
    OR NOT coalesce(policy.allowed_purpose ? 'enrichment', false) OR NOT coalesce((publisher->'allowedPurposes') ? 'enrichment', false)
    OR publisher->'allowedActions' IS DISTINCT FROM e->'allowedActions'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(publisher->'detailPathPrefixes') p WHERE source_path=p OR starts_with(source_path,rtrim(p,'/')||'/'))
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(policy.allowed_paths) p WHERE source_path=p OR starts_with(source_path,rtrim(p,'/')||'/'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(nullif(policy.disallowed_paths,'null'::jsonb)) p
      WHERE source_path=p OR starts_with(source_path,rtrim(p,'/')||'/'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(publisher->'knownCorporateDomains') d
      WHERE e->>'targetDomain'=d OR right(e->>'targetDomain',length(d)+1)='.'||d
        OR right(d,length(e->>'targetDomain')+1)='.'||(e->>'targetDomain'))
    OR (e->>'expiresAt')::timestamptz > least((publisher->>'expiresAt')::timestamptz,(independent->>'expiresAt')::timestamptz,
      (e->>'fetchedAt')::timestamptz + policy.retention_days*interval '1 day')
  THEN RETURN false; END IF;
  IF e ? 'identityEvidenceRefs' AND (NOT coalesce(independent->'identityEvidenceRefs','[]'::jsonb) @> (e->'identityEvidenceRefs')
    OR NOT public.manufacturer_network_identity_refs_valid_v1(w,c,e->'identityEvidenceRefs',company.domain,company.country))
  THEN RAISE EXCEPTION 'DISCOVERY_V3_MANUFACTURER_SUBJECT_INVALID'; END IF;

  SELECT * INTO previous FROM public.discovery_v3_manufacturer_evidence WHERE workspace_id=w AND company_id=c AND run_id=r;
  IF FOUND THEN
    IF previous.evidence=e AND previous.lookup_operation_id=lookup_id AND previous.fetch_operation_id=fetch_id
      AND previous.lookup_result_sha256=lookup_digest AND previous.fetch_result_sha256=fetch_digest AND previous.consumer_sha256=consumer_digest
    THEN RETURN true; END IF;
    RAISE EXCEPTION 'DISCOVERY_V3_MANUFACTURER_EVIDENCE_IMMUTABLE';
  END IF;
  INSERT INTO public.discovery_v3_manufacturer_evidence(workspace_id,company_id,run_id,lookup_operation_id,fetch_operation_id,
    lookup_result_sha256,fetch_result_sha256,consumer_sha256,artifact_id,evidence)
    VALUES(w,c,r,lookup_id,fetch_id,lookup_digest,fetch_digest,consumer_digest,artifact.id,e);
  RETURN true;
END $$;

CREATE FUNCTION public.read_discovery_v3_manufacturer_evidence_v1(w uuid,c uuid,r uuid,request_digest text)
RETURNS TABLE(evidence jsonb) LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.evidence FROM public.discovery_v3_manufacturer_evidence p
  JOIN public.discovery_run a ON a.workspace_id=w AND a.id=r AND a.execution_contract_version=3 AND a.v3_request_sha256=request_digest
  JOIN public.canonical_company company ON company.workspace_id=w AND company.id=c AND company.status<>'SUPPRESSED'
  JOIN public.discovery_v3_operation q ON q.workspace_id=w AND q.run_id=r AND q.id=p.lookup_operation_id
    AND q.status='SUCCEEDED' AND q.result_sha256=p.lookup_result_sha256 AND q.ack=p.consumer_sha256
  JOIN public.discovery_v3_operation f ON f.workspace_id=w AND f.run_id=r AND f.id=p.fetch_operation_id
    AND f.status='SUCCEEDED' AND f.result_sha256=p.fetch_result_sha256 AND f.ack=p.consumer_sha256
  JOIN public.generic_operation_artifact m ON m.workspace_id=w AND m.id=p.artifact_id AND m.discovery_v3_operation_id=f.id
    AND m.execution_contract_version=3 AND m.expires_at>now()
  JOIN public.generic_operation_artifact_subject s ON s.workspace_id=w AND s.artifact_id=m.id AND s.subject_type='company' AND s.subject_id=c
  WHERE p.workspace_id=w AND p.company_id=c AND p.run_id=r AND w=nullif(current_setting('app.current_workspace_id',true),'')::uuid
    AND (p.evidence->>'expiresAt')::timestamptz>now()
    AND NOT EXISTS (SELECT 1 FROM public.generic_operation_artifact_subject_tombstone t WHERE t.workspace_id=w AND t.subject_type='company' AND t.subject_id=c)
$$;

REVOKE ALL ON FUNCTION public.enforce_discovery_v3_manufacturer_ack_v1() FROM PUBLIC,app_user;
REVOKE ALL ON FUNCTION public.commit_discovery_v3_manufacturer_evidence_v1(uuid,uuid,uuid,text,integer,uuid,text,uuid,text,text,jsonb) FROM PUBLIC,app_user;
REVOKE ALL ON FUNCTION public.read_discovery_v3_manufacturer_evidence_v1(uuid,uuid,uuid,text) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.commit_discovery_v3_manufacturer_evidence_v1(uuid,uuid,uuid,text,integer,uuid,text,uuid,text,text,jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION public.read_discovery_v3_manufacturer_evidence_v1(uuid,uuid,uuid,text) TO app_user;

COMMIT;
