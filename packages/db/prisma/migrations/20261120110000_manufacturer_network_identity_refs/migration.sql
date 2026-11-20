-- Reviewed, independently sourced legal-name references; no historical rows are rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.manufacturer_network_evidence_valid_v1(p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v jsonb;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p)) NOT IN (21,22) OR (SELECT count(*) FROM jsonb_object_keys(p))=22 AND NOT p ? 'identityEvidenceRefs'
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
  IF k NOT IN ('spans','allowedActions','identityEvidenceRefs') AND (jsonb_typeof(v) <> 'string' OR octet_length(v#>>'{}') > 1024 OR normalize(v#>>'{}',NFKC) <> v#>>'{}') THEN RETURN false; END IF;
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
 IF p ? 'identityEvidenceRefs' THEN
  IF jsonb_typeof(p->'identityEvidenceRefs')<>'array' OR jsonb_array_length(p->'identityEvidenceRefs') NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
  IF (SELECT count(DISTINCT item->>'fieldEvidenceId') FROM jsonb_array_elements(p->'identityEvidenceRefs') item)<>jsonb_array_length(p->'identityEvidenceRefs') THEN RETURN false; END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(p->'identityEvidenceRefs') LOOP
   IF jsonb_typeof(v)<>'object' OR jsonb_typeof(v->'fieldEvidenceId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'valueSha256') IS DISTINCT FROM 'string' OR (SELECT count(*) FROM jsonb_object_keys(v))<>2 OR NOT v ?& ARRAY['fieldEvidenceId','valueSha256']
   OR v->>'fieldEvidenceId' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' OR v->>'valueSha256' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.manufacturer_network_identity_refs_valid_v1(w uuid,c uuid,refs jsonb,d text,p_country text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ref jsonb; f public.field_evidence; host text; accepted boolean;
BEGIN
 IF w IS DISTINCT FROM nullif(current_setting('app.current_workspace_id',true),'')::uuid OR p_country IS DISTINCT FROM 'DE'
 OR jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs) NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.canonical_company WHERE id=c AND workspace_id=w AND domain=d AND canonical_company.country=p_country AND status<>'SUPPRESSED') THEN RETURN false; END IF;
 FOR ref IN SELECT * FROM jsonb_array_elements(refs) LOOP
  SELECT * INTO f FROM public.field_evidence WHERE id=(ref->>'fieldEvidenceId')::uuid AND workspace_id=w AND entity_type='company' AND entity_id=c;
  IF NOT FOUND OR jsonb_typeof(f.value)<>'string' OR NOT public.raw_source_provider_company_name_valid_v2(f.value#>>'{}') OR f.data_class<>'green' OR btrim(f.license) ~* '^(sandbox|unknown|unreviewed|none|no_license)$' OR length(btrim(f.license))=0
  OR jsonb_typeof(f.allowed_actions) IS DISTINCT FROM 'array' OR NOT coalesce(f.allowed_actions,'[]'::jsonb) ? 'match' OR f.fetched_at>now() OR f.fetched_at<now()-interval '30 days'
  OR encode(public.digest(f.value#>>'{}','sha256'),'hex') IS DISTINCT FROM ref->>'valueSha256'
  OR f.source_url IS NULL OR f.source_url !~ '^https://[^/:?#@]+/' THEN RETURN false; END IF;
  host=lower(split_part(f.source_url,'/',3));
  accepted=f.field='website_profile.legal_name' AND f.provider_key='website_profile' AND regexp_replace(host,'^www[.]','')=regexp_replace(lower(d),'^www[.]','');
  IF f.field='gleif.legal_name' AND f.provider_key='gleif' AND host IN ('api.gleif.org','search.gleif.org') THEN
   accepted=EXISTS(SELECT 1 FROM public.canonical_company WHERE id=c AND workspace_id=w AND attributes#>>'{gleif,registered_country}'=p_country)
   AND EXISTS(SELECT 1 FROM public.source_policy WHERE domain=host AND source_type='gov_registry' AND review_status='APPROVED' AND terms_status IN ('REVIEWED_OK','REVIEWED_RESTRICTED') AND jsonb_typeof(allowed_purpose)='array' AND allowed_purpose ? 'enrichment');
  END IF;
  IF NOT accepted THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER FUNCTION public.manufacturer_network_identity_refs_valid_v1(uuid,uuid,jsonb,text,text) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.manufacturer_network_identity_refs_valid_v1(uuid,uuid,jsonb,text,text) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.commit_manufacturer_network_evidence_v1(w uuid,c uuid,r uuid,a uuid,s uuid,e jsonb)
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
 IF e ? 'identityEvidenceRefs' AND (
 NOT coalesce(att->'identityEvidenceRefs','[]'::jsonb) @> (e->'identityEvidenceRefs')
 OR NOT public.manufacturer_network_identity_refs_valid_v1(w,c,e->'identityEvidenceRefs',co.domain,co.country)
 ) THEN RAISE EXCEPTION 'MANUFACTURER_IDENTITY_REFERENCE_INVALID'; END IF;
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

-- CREATE OR REPLACE preserves existing owner and ACL.
COMMIT;
