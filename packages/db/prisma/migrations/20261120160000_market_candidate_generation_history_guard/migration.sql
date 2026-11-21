-- Forward-only: immutable historical ACK/set integrity and DB first-commit latest-intent fencing.
-- Existing function identity, ownership, ACL and invocation security are retained. No tables or grants change.

CREATE OR REPLACE FUNCTION market_candidate_generation_terminal_v1(g market_candidate_generation) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS (
   SELECT 1 FROM market_candidate_generation_attempt a
   JOIN tool_budget_account b ON b.scope_key=a.scope_key AND b.account_key=a.account_key
     AND b.authority_id=a.authority_id AND b.generation=a.account_generation
   JOIN tool_budget_operation o ON o.scope_key=b.scope_key AND o.account_id=b.id AND o.generation=a.account_generation
     AND o.operation_key=a.expected_operation_key AND o.id=g.execution_operation_id AND o.status='SETTLED'
   JOIN execution_domain_ack k ON k.ack_id=g.consumer_ack_id AND k.scope_key=o.scope_key
     AND k.operation_id=o.id AND k.operation_key=o.operation_key AND k.account_id=b.id AND k.authority_id=a.authority_id
   WHERE a.id=g.active_attempt_id AND a.workspace_id=g.workspace_id AND a.company_id=g.company_id AND a.generation_id=g.id
     AND g.result_schema='market-candidates-generation/v1' AND g.result_digest ~ '^[0-9a-f]{64}$'
     AND o.result_schema=g.result_schema AND o.result_digest=g.result_digest
     AND k.result_strategy='typed_projection' AND k.artifact_id IS NULL
     AND k.result_schema=g.result_schema AND k.result_digest=g.result_digest
     AND k.consumer='MarketCandidateGenerationService.apply' AND k.domain_aggregate_type='MarketCandidateGeneration'
     AND k.domain_ack_key=encode(public.digest(g.id::text,'sha256'),'hex')
     AND k.domain_revision=encode(public.digest('1','sha256'),'hex')
     AND (g.phase='NOT_APPLIED' OR (
       EXISTS(SELECT 1 FROM market_candidate_set s WHERE s.id=g.set_id AND s.workspace_id=g.workspace_id
         AND s.company_id=g.company_id AND s.initial_operation_id=g.id)
     ))
 );
$$;

CREATE OR REPLACE FUNCTION market_candidate_generation_lifecycle_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE mutable_fields text[]:=ARRAY['phase','reason_code','active_attempt_id','set_id','updated_at',
 'execution_operation_id','result_schema','result_digest','consumer_ack_id','consumed_at'];
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.phase<>'PREPARED' OR NEW.active_attempt_id IS NOT NULL OR NEW.reason_code IS NOT NULL THEN
     RAISE EXCEPTION 'MARKET_GENERATION_INITIAL_STATE' USING ERRCODE='23514';
   END IF;
 ELSE
   IF to_jsonb(NEW)-mutable_fields IS DISTINCT FROM to_jsonb(OLD)-mutable_fields THEN
     RAISE EXCEPTION 'MARKET_GENERATION_IMMUTABLE_INTENT' USING ERRCODE='23514';
   END IF;
   IF OLD.phase IN('PERSISTED','NOT_APPLIED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
     RAISE EXCEPTION 'MARKET_GENERATION_TERMINAL_IMMUTABLE' USING ERRCODE='23514';
   END IF;
   IF NEW.phase<>OLD.phase AND NOT (CASE OLD.phase
     WHEN 'PREPARED' THEN NEW.phase IN('RUNNING','FAILED')
     WHEN 'RUNNING' THEN NEW.phase IN('RESULT_UNKNOWN','RESULT_READY','FAILED','PERSISTED','NOT_APPLIED')
     WHEN 'RESULT_UNKNOWN' THEN NEW.phase IN('RESULT_READY','FAILED')
     WHEN 'RESULT_READY' THEN NEW.phase IN('PERSISTED','NOT_APPLIED')
     WHEN 'FAILED' THEN NEW.phase IN('RUNNING','RESULT_READY')
     ELSE false END) THEN RAISE EXCEPTION 'MARKET_GENERATION_PHASE_STEP' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.phase='PREPARED' AND NEW.active_attempt_id IS NOT NULL THEN
   RAISE EXCEPTION 'MARKET_GENERATION_INITIAL_STATE' USING ERRCODE='23514';
 END IF;
 -- Latest-intent is a first-commit fence, not a revocation of immutable historical facts.
 IF NEW.phase='PERSISTED' AND OLD.phase IS DISTINCT FROM 'PERSISTED' AND NOT EXISTS(
   SELECT 1 FROM market_candidate_generation_head h WHERE h.workspace_id=NEW.workspace_id
     AND h.company_id=NEW.company_id AND h.latest_generation_id=NEW.id AND h.intent_sequence=NEW.intent_sequence
 ) THEN
   RAISE EXCEPTION 'MARKET_GENERATION_LATEST_COMMIT_REQUIRED' USING ERRCODE='23514';
 END IF;
 IF NEW.phase IN('PERSISTED','NOT_APPLIED') AND NOT market_candidate_generation_terminal_v1(NEW) THEN
   RAISE EXCEPTION 'MARKET_GENERATION_EXACT_TERMINAL_ACK_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
