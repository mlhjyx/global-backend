-- Forward-only M1 projection. No historical rows are scanned or rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A phase has one frozen operation identity for this run/company. Drift cannot create a second query/URL.
CREATE TABLE public.manufacturer_network_probe (
 workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES public.canonical_company(id) ON DELETE CASCADE,
 run_id uuid NOT NULL REFERENCES public.discovery_run(id) ON DELETE CASCADE,
 authority_id uuid NOT NULL REFERENCES public.execution_budget_authority(id) ON DELETE CASCADE,
 phase text NOT NULL CHECK(phase IN ('lookup','fetch')),
 identity_sha256 char(64) NOT NULL CHECK(identity_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,company_id,run_id,phase)
);
ALTER TABLE public.manufacturer_network_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manufacturer_network_probe FORCE ROW LEVEL SECURITY;
CREATE POLICY manufacturer_network_probe_workspace ON public.manufacturer_network_probe
 USING(workspace_id=nullif(current_setting('app.current_workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.current_workspace_id',true),'')::uuid);
REVOKE ALL ON public.manufacturer_network_probe FROM PUBLIC,app_user,runtime_api,runtime_worker,runtime_platform_worker,runtime_outbox_relay;
GRANT SELECT ON public.manufacturer_network_probe TO app_user;
CREATE FUNCTION public.admit_manufacturer_network_probe_v1(w uuid,c uuid,r uuid,a uuid,p text,h text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE prior public.manufacturer_network_probe;
BEGIN
 IF w IS DISTINCT FROM nullif(current_setting('app.current_workspace_id',true),'')::uuid OR p IS NULL OR h IS NULL OR p NOT IN ('lookup','fetch') OR h !~ '^[a-f0-9]{64}$'
 OR NOT EXISTS(SELECT 1 FROM public.discovery_company_job j JOIN public.discovery_run d ON d.id=j.run_id AND d.workspace_id=j.workspace_id
 JOIN public.canonical_company co ON co.id=j.canonical_company_id AND co.workspace_id=j.workspace_id
 WHERE j.workspace_id=w AND j.canonical_company_id=c AND j.run_id=r AND j.stage='profiling' AND co.status<>'SUPPRESSED')
 OR NOT EXISTS(SELECT 1 FROM public.execution_budget_authority WHERE id=a AND scope_key=w::text AND purpose='discovery.run' AND authority_kind='WORKSPACE_GRANT')
 THEN RETURN false; END IF;
 INSERT INTO public.manufacturer_network_probe(workspace_id,company_id,run_id,authority_id,phase,identity_sha256)
 VALUES(w,c,r,a,p,h) ON CONFLICT DO NOTHING;
 SELECT * INTO prior FROM public.manufacturer_network_probe WHERE workspace_id=w AND company_id=c AND run_id=r AND phase=p;
 RETURN prior.authority_id=a AND prior.identity_sha256=h;
END $$;
ALTER FUNCTION public.admit_manufacturer_network_probe_v1(uuid,uuid,uuid,uuid,text,text) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.admit_manufacturer_network_probe_v1(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.admit_manufacturer_network_probe_v1(uuid,uuid,uuid,uuid,text,text) TO app_user;

CREATE FUNCTION public.manufacturer_network_evidence_valid_v1(p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v jsonb;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p)) <> 21
 OR NOT p ?& ARRAY['schemaVersion','workspaceId','companyId','publisherId','targetDomain','targetName','country','sourceUrl','fetchedAt','expiresAt','relationship','spans','artifactId','operationId','resultDigest','contentHash','sourcePolicyId','licenseLabel','allowedActions','sourceReviewRef','independenceReviewRef']
 THEN RETURN false; END IF;
 IF p->>'schemaVersion' <> 'manufacturer-network-evidence/v1' OR p->>'country' <> 'DE'
 OR p->>'relationship' <> 'authorized_distributor' OR p->'allowedActions' <> '["display","match"]'::jsonb
 OR p->>'targetDomain' !~ '^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$'
 OR p->>'sourceUrl' !~ '^https://[^/?#@:]+/[^?#]+$'
 OR p->>'resultDigest' !~ '^[a-f0-9]{64}$' OR p->>'contentHash' !~ '^[a-f0-9]{24}$'
 OR (p->>'expiresAt')::timestamptz <= (p->>'fetchedAt')::timestamptz
 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['workspaceId','companyId','artifactId','operationId','sourcePolicyId'] LOOP
  IF p->>k !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
 END LOOP;
 FOR k,v IN SELECT * FROM jsonb_each(p) LOOP
  IF k NOT IN ('spans','allowedActions') AND (jsonb_typeof(v) <> 'string' OR octet_length(v#>>'{}') > 1024 OR normalize(v#>>'{}',NFKC) <> v#>>'{}') THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['targetName','licenseLabel','publisherId','sourceReviewRef','independenceReviewRef'] LOOP
  IF octet_length(p->>k) NOT BETWEEN 1 AND 400 OR NOT public.raw_source_text_contact_safe_v2(p->>k) THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(p->'spans') <> 'array' OR jsonb_array_length(p->'spans') NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
 FOR v IN SELECT * FROM jsonb_array_elements(p->'spans') LOOP
  IF jsonb_typeof(v) <> 'string' OR char_length(v#>>'{}') NOT BETWEEN 1 AND 400
  OR NOT public.raw_source_text_contact_safe_v2(v#>>'{}') OR normalize(v#>>'{}',NFKC) <> v#>>'{}'
  OR (v#>>'{}') ~* '(gesch(ä|ae)ftsf(ü|ue)hr|inhaber|ansprechpartner|vorstand|kontaktperson|managing director|contact person|contact:|kontakt:)' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE TABLE public.manufacturer_network_evidence (
 workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES public.canonical_company(id) ON DELETE CASCADE,
 run_id uuid NOT NULL REFERENCES public.discovery_run(id) ON DELETE CASCADE,
 artifact_id uuid NOT NULL REFERENCES public.generic_operation_artifact(id) ON DELETE CASCADE,
 search_operation_id uuid NOT NULL REFERENCES public.tool_budget_operation(id) ON DELETE CASCADE,
 evidence jsonb NOT NULL CHECK (public.manufacturer_network_evidence_valid_v1(evidence)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (workspace_id,company_id,run_id),
 UNIQUE (artifact_id)
);
ALTER TABLE public.manufacturer_network_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manufacturer_network_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY manufacturer_network_evidence_workspace ON public.manufacturer_network_evidence
 USING (workspace_id = nullif(current_setting('app.current_workspace_id',true),'')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id',true),'')::uuid);
REVOKE ALL ON public.manufacturer_network_evidence FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_platform_worker, runtime_outbox_relay;
GRANT SELECT ON public.manufacturer_network_evidence TO app_user;

CREATE FUNCTION public.commit_manufacturer_network_evidence_v1(w uuid,c uuid,r uuid,a uuid,s uuid,e jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE m public.generic_operation_artifact; f public.tool_budget_operation; q public.tool_budget_operation; cfg jsonb; src jsonb; att jsonb; pol public.source_policy; co public.canonical_company; prior jsonb;
BEGIN
 IF w IS DISTINCT FROM nullif(current_setting('app.current_workspace_id',true),'')::uuid
 OR NOT public.manufacturer_network_evidence_valid_v1(e) OR e->>'workspaceId' <> w::text OR e->>'companyId' <> c::text
 THEN RAISE EXCEPTION 'MANUFACTURER_EVIDENCE_SCOPE_INVALID'; END IF;
 SELECT * INTO co FROM public.canonical_company WHERE id=c AND workspace_id=w FOR UPDATE;
 IF NOT FOUND OR co.status='SUPPRESSED' THEN RETURN false; END IF;
 IF co.country IS DISTINCT FROM 'DE' OR co.domain IS DISTINCT FROM e->>'targetDomain' OR co.name IS DISTINCT FROM e->>'targetName'
 OR NOT EXISTS(SELECT 1 FROM public.discovery_run WHERE id=r AND workspace_id=w)
 THEN RAISE EXCEPTION 'MANUFACTURER_EVIDENCE_SUBJECT_INVALID'; END IF;
 SELECT * INTO m FROM public.generic_operation_artifact WHERE id=(e->>'artifactId')::uuid AND workspace_id=w AND authority_id=a;
 SELECT * INTO f FROM public.tool_budget_operation WHERE id=(e->>'operationId')::uuid AND scope_key=w::text;
 SELECT * INTO q FROM public.tool_budget_operation WHERE id=s AND scope_key=w::text;
 IF m.id IS NULL OR f.id IS NULL OR q.id IS NULL OR m.operation_id<>f.id OR m.sha256<>e->>'resultDigest'
 OR m.result_schema<>'crawl4ai-fetch/v1' OR f.result_schema<>'crawl4ai-fetch/v1' OR q.result_schema<>'searxng-search/v1'
 OR f.status::text<>'SETTLED' OR q.status::text<>'SETTLED' OR f.account_id<>q.account_id
 OR m.expected_sanitized_url IS DISTINCT FROM e->>'sourceUrl' OR m.expected_content_hash IS DISTINCT FROM e->>'contentHash'
 OR m.created_at IS DISTINCT FROM (e->>'fetchedAt')::timestamptz OR m.expires_at < (e->>'expiresAt')::timestamptz
 OR m.expires_at<=clock_timestamp() OR (e->>'expiresAt')::timestamptz<=clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM public.manufacturer_network_probe WHERE workspace_id=w AND company_id=c AND run_id=r AND authority_id=a AND phase='lookup' AND identity_sha256=q.operation_key)
 OR NOT EXISTS(SELECT 1 FROM public.manufacturer_network_probe WHERE workspace_id=w AND company_id=c AND run_id=r AND authority_id=a AND phase='fetch' AND identity_sha256=f.operation_key)
 OR NOT EXISTS(SELECT 1 FROM public.tool_budget_account WHERE id=f.account_id AND scope_key=w::text AND authority_id=a)
 OR NOT EXISTS(SELECT 1 FROM public.generic_operation_artifact_subject WHERE artifact_id=m.id AND workspace_id=w AND subject_type='company' AND subject_id=c)
 OR EXISTS(SELECT 1 FROM public.generic_operation_artifact_subject_tombstone WHERE workspace_id=w AND subject_type='company' AND subject_id=c)
 OR NOT EXISTS(SELECT 1 FROM public.execution_domain_ack WHERE operation_id=f.id AND scope_key=w::text AND consumer='WebCrawlKnowledgeSource' AND result_digest=m.sha256 AND domain_revision=encode(public.digest(m.sha256,'sha256'),'hex') AND domain_ack_key=encode(public.digest(c::text||':'||f.id::text||':enrichment','sha256'),'hex'))
 OR NOT EXISTS(SELECT 1 FROM public.execution_domain_ack WHERE operation_id=q.id AND scope_key=w::text AND consumer='SearchDiscoveryProvider' AND result_digest=q.result_digest AND domain_revision=encode(public.digest(q.result_digest,'sha256'),'hex') AND domain_ack_key=encode(public.digest(c::text||':'||q.id::text||':enrichment','sha256'),'hex'))
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.result_json#>'{data,data,data,results}') AS candidate WHERE candidate->>'url'=e->>'sourceUrl')
 THEN RAISE EXCEPTION 'MANUFACTURER_EVIDENCE_RECEIPT_INVALID'; END IF;
 SELECT config INTO cfg FROM public.data_provider WHERE key='manufacturer_network' AND status='ENABLED';
 IF cfg->>'schemaVersion' IS DISTINCT FROM 'manufacturer-network-sources/v1' THEN RETURN false; END IF;
 SELECT value INTO src FROM jsonb_array_elements(cfg->'sources') WHERE value->>'publisherId'=e->>'publisherId'
 AND value->>'reviewRef'=e->>'sourceReviewRef' AND value->>'licenseLabel'=e->>'licenseLabel'
 AND (value->>'reviewedAt')::timestamptz<=clock_timestamp() AND (value->>'expiresAt')::timestamptz>clock_timestamp();
 SELECT value INTO att FROM jsonb_array_elements(cfg->'independenceAttestations') WHERE value->>'publisherId'=e->>'publisherId'
 AND value->>'workspaceId'=w::text AND value->>'companyId'=c::text AND value->>'targetDomain'=co.domain
 AND value->>'reviewRef'=e->>'independenceReviewRef' AND jsonb_array_length(value->'independenceBasisRefs')>0
 AND (value->>'reviewedAt')::timestamptz<=clock_timestamp() AND (value->>'expiresAt')::timestamptz>clock_timestamp();
 SELECT * INTO pol FROM public.source_policy WHERE id=(e->>'sourcePolicyId')::uuid;
 IF src IS NULL OR att IS NULL OR pol.id IS NULL OR pol.domain NOT IN (src->>'domain','www.'||(src->>'domain')) OR pol.review_status<>'APPROVED'
 OR pol.source_type<>'official_website' OR pol.terms_status NOT IN ('REVIEWED_OK','REVIEWED_RESTRICTED')
 OR NOT pol.allowed_purpose ? 'enrichment' OR src->'allowedActions'<>e->'allowedActions'
 OR NOT src->'allowedPurposes' ? 'enrichment'
 OR e->>'sourceUrl' NOT LIKE 'https://' || (src->>'domain') || '/%'
 AND e->>'sourceUrl' NOT LIKE 'https://www.' || (src->>'domain') || '/%'
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(src->'detailPathPrefixes') AS p WHERE (regexp_replace(e->>'sourceUrl','^https://[^/]+','')=p OR starts_with(regexp_replace(e->>'sourceUrl','^https://[^/]+',''),rtrim(p,'/')||'/')))
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(pol.allowed_paths) AS p WHERE (regexp_replace(e->>'sourceUrl','^https://[^/]+','')=p OR starts_with(regexp_replace(e->>'sourceUrl','^https://[^/]+',''),rtrim(p,'/')||'/')))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(pol.disallowed_paths) AS p WHERE (regexp_replace(e->>'sourceUrl','^https://[^/]+','')=p OR starts_with(regexp_replace(e->>'sourceUrl','^https://[^/]+',''),rtrim(p,'/')||'/')))
 THEN RETURN false; END IF;
 SELECT evidence INTO prior FROM public.manufacturer_network_evidence WHERE workspace_id=w AND company_id=c AND run_id=r;
 IF FOUND THEN
  IF prior IS DISTINCT FROM e THEN RAISE EXCEPTION 'MANUFACTURER_EVIDENCE_IMMUTABLE'; END IF;
  RETURN true;
 END IF;
 INSERT INTO public.manufacturer_network_evidence(workspace_id,company_id,run_id,artifact_id,search_operation_id,evidence) VALUES(w,c,r,m.id,s,e);
 UPDATE public.canonical_company SET attributes=coalesce(attributes,'{}'::jsonb)||jsonb_build_object('manufacturer_network',jsonb_build_object('evidence',e)), version=version+1 WHERE id=c AND workspace_id=w;
 INSERT INTO public.field_evidence(id,workspace_id,entity_type,entity_id,field,value,provider_key,confidence,license,allowed_actions,source_url,fetched_at)
 VALUES(gen_random_uuid(),w,'company',c,'manufacturer_network.evidence',e,'manufacturer_network',1,e->>'licenseLabel',e->'allowedActions',e->>'sourceUrl',(e->>'fetchedAt')::timestamptz);
 RETURN true;
END $$;

CREATE FUNCTION public.read_manufacturer_network_evidence_v1(w uuid,c uuid,r uuid)
RETURNS TABLE(evidence jsonb) LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT x.evidence FROM public.manufacturer_network_evidence x
 JOIN public.generic_operation_artifact m ON m.id=x.artifact_id AND m.workspace_id=w
 JOIN public.canonical_company co ON co.id=c AND co.workspace_id=w AND co.status<>'SUPPRESSED'
 JOIN public.generic_operation_artifact_subject s ON s.artifact_id=m.id AND s.workspace_id=w AND s.subject_type='company' AND s.subject_id=c
 WHERE x.workspace_id=w AND x.company_id=c AND x.run_id=r AND w=nullif(current_setting('app.current_workspace_id',true),'')::uuid
 AND m.expires_at>now() AND (x.evidence->>'expiresAt')::timestamptz>now()
 AND NOT EXISTS(SELECT 1 FROM public.generic_operation_artifact_subject_tombstone t WHERE t.workspace_id=w AND t.subject_type='company' AND t.subject_id=c)
$$;
ALTER FUNCTION public.manufacturer_network_evidence_valid_v1(jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION public.commit_manufacturer_network_evidence_v1(uuid,uuid,uuid,uuid,uuid,jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION public.read_manufacturer_network_evidence_v1(uuid,uuid,uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.manufacturer_network_evidence_valid_v1(jsonb) FROM PUBLIC,app_user;
REVOKE ALL ON FUNCTION public.commit_manufacturer_network_evidence_v1(uuid,uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,app_user;
REVOKE ALL ON FUNCTION public.read_manufacturer_network_evidence_v1(uuid,uuid,uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.commit_manufacturer_network_evidence_v1(uuid,uuid,uuid,uuid,uuid,jsonb),public.read_manufacturer_network_evidence_v1(uuid,uuid,uuid) TO app_user;

CREATE OR REPLACE FUNCTION public.sanitize_canonical_company_attributes_v3(p_attributes jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT coalesce(public.raw_source_prune_empty_json_v4(public.sanitize_canonical_company_attributes_v2(p_attributes - 'manufacturer_network')),'{}'::jsonb)
 || CASE WHEN public.manufacturer_network_evidence_valid_v1(p_attributes#>'{manufacturer_network,evidence}')
 THEN jsonb_build_object('manufacturer_network',jsonb_build_object('evidence',p_attributes#>'{manufacturer_network,evidence}')) ELSE '{}'::jsonb END
$$;
REVOKE ALL ON FUNCTION public.sanitize_canonical_company_attributes_v3(jsonb) FROM PUBLIC,app_user;
CREATE OR REPLACE FUNCTION raw_source_sanitize_stored_company_field_evidence_v1(
  p_field TEXT,
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  path_parts TEXT[];
  wrapped JSONB := p_value;
  sanitized JSONB;
  part TEXT;
  item_index INTEGER;
BEGIN
  IF p_field='manufacturer_network.evidence' THEN
    RETURN CASE WHEN public.manufacturer_network_evidence_valid_v1(p_value) THEN p_value ELSE NULL END;
  END IF;
  IF p_field='attributes' THEN
    sanitized := public.sanitize_canonical_company_attributes_v3(p_value);
    RETURN CASE WHEN sanitized='{}'::jsonb THEN NULL ELSE sanitized END;
  ELSIF p_field='name' THEN
    IF jsonb_typeof(p_value)='string'
      AND public.raw_source_provider_company_name_valid_v2(p_value #>> '{}')
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field='domain' THEN
    IF jsonb_typeof(p_value)='string'
      AND normalize(p_value #>> '{}',NFKC)=p_value #>> '{}'
      AND lower(p_value #>> '{}')=p_value #>> '{}'
      AND octet_length(p_value #>> '{}') <= 253
      AND p_value #>> '{}' ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
      AND public.raw_source_text_contact_safe_v2(p_value #>> '{}')
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field IN ('country','industry','region') THEN
    IF jsonb_typeof(p_value)='string'
      AND normalize(p_value #>> '{}',NFKC)=p_value #>> '{}'
      AND octet_length(p_value #>> '{}') <= 160
      AND public.raw_source_text_contact_safe_v2(p_value #>> '{}')
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field='employee_count' THEN
    IF jsonb_typeof(p_value)='number'
      AND (p_value #>> '{}')::NUMERIC BETWEEN 0 AND 2147483647
      AND trunc((p_value #>> '{}')::NUMERIC)=(p_value #>> '{}')::NUMERIC
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field='revenue_usd' THEN
    IF jsonb_typeof(p_value)='number'
      AND (p_value #>> '{}')::NUMERIC BETWEEN 0 AND 1000000000000000
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field='identity' THEN
    RETURN public.raw_source_sanitize_stored_identity_v1(p_value);
  ELSIF p_field IN (
    'intent.tender','intent.sources_sought','intent.website_change'
  ) THEN
    RETURN public.sanitize_canonical_company_attributes_v3(
      jsonb_build_object('intent',p_value)
    )->'intent';
  ELSIF p_field='intent.clearance' THEN
    RETURN public.sanitize_canonical_company_attributes_v3(
      jsonb_build_object('intent',jsonb_build_object(
        'events',jsonb_build_array(p_value)
      ))
    ) #> '{intent,events,0}';
  ELSIF p_field='structured_harvest.site_sections' THEN
    RETURN public.raw_source_sanitize_site_sections_v1(p_value);
  END IF;

  path_parts := public.raw_source_stored_field_attribute_path_v1(p_field);
  IF path_parts IS NULL THEN RETURN NULL; END IF;
  FOR item_index IN REVERSE array_upper(path_parts,1)..array_lower(path_parts,1)
  LOOP
    wrapped := jsonb_build_object(path_parts[item_index],wrapped);
  END LOOP;
  sanitized := public.sanitize_canonical_company_attributes_v3(wrapped);
  FOREACH part IN ARRAY path_parts LOOP
    sanitized := sanitized->part;
    IF sanitized IS NULL THEN RETURN NULL; END IF;
  END LOOP;
  RETURN sanitized;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.raw_source_sanitize_stored_company_field_evidence_v1(text,jsonb) FROM PUBLIC,app_user;

COMMIT;
