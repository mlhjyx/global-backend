-- B2 source-only forward migration: existing workspace pairs are preserved/restored;
-- market.candidates.generate has its own 30-minute admission lease, not a longer JWT.
-- Baseline consume validation, replay, clocks, SECURITY DEFINER and EXECUTE ACL stay intact.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "execution_budget_authority"
  DROP CONSTRAINT "execution_budget_authority_kind_shape_check",
  ADD CONSTRAINT "execution_budget_authority_kind_shape_check" CHECK
(
    (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND "workspace_id" IS NOT NULL
      AND "scope_key" = "workspace_id"::text
      AND "purpose" IN (
        'icp.design', 'icp.query_plan', 'understanding.run',
        'discovery.run', 'contact.verify', 'contact.enrich',
        'outreach.draft', 'campaign.plan', 'market.candidates.generate'
      )
      AND (
        ("purpose" = 'understanding.run' AND "subject_type" = 'company')
        OR ("purpose" = 'icp.design' AND "subject_type" = 'company')
        OR ("purpose" = 'icp.query_plan' AND "subject_type" = 'icp')
        OR (
          "purpose" = 'discovery.run'
          AND "subject_type" IN ('discovery_run', 'company')
        )
        OR ("purpose" = 'contact.verify' AND "subject_type" = 'contact_point')
        OR ("purpose" = 'contact.enrich' AND "subject_type" = 'company')
        OR ("purpose" = 'outreach.draft' AND "subject_type" = 'lead')
        OR ("purpose" = 'campaign.plan' AND "subject_type" = 'campaign')
        OR ("purpose" = 'market.candidates.generate' AND "subject_type" = 'market_candidate_generation')
      )
      AND "request_sha256" IS NOT NULL
      AND "request_sha256" ~ '^[0-9a-f]{64}$'
      AND "schedule_id" IS NULL
      AND "crawl_run_id" IS NULL
      AND "cap_microusd" IS NOT NULL
      AND "cap_microusd" > 0
      AND "cap_per_run_microusd" IS NULL
      AND "campaign_cap_microusd" IS NULL
      AND "max_runs" IS NULL
      AND "runs_consumed" BETWEEN 0 AND 1
      AND "consumed_at" IS NOT NULL
    )
    OR
    (
      "authority_kind" = 'PLATFORM_GRANT'
      AND "workspace_id" IS NULL
      AND "scope_key" = 'platform'
      AND "purpose" IN (
        'platform.acquisition', 'platform.intent_watch', 'platform.sanctions'
      )
      AND "request_sha256" IS NULL
      AND "crawl_run_id" IS NULL
      AND "schedule_id" IS NOT NULL
      AND char_length(btrim("schedule_id")) BETWEEN 1 AND 191
      AND "subject_type" IS NOT DISTINCT FROM 'schedule'
      AND "subject_id" IS NOT DISTINCT FROM "schedule_id"
      AND "cap_microusd" IS NULL
      AND "cap_per_run_microusd" IS NOT NULL
      AND "cap_per_run_microusd" > 0
      AND "campaign_cap_microusd" IS NOT NULL
      AND "campaign_cap_microusd" > 0
      AND "max_runs" IS NOT NULL
      AND "max_runs" > 0
      AND "runs_consumed" <= "max_runs"
      AND (
        ("runs_consumed" = 0 AND "consumed_at" IS NULL)
        OR ("runs_consumed" > 0 AND "consumed_at" IS NOT NULL)
      )
    )
    OR
    (
      "authority_kind" = 'PLATFORM_GRANT'
      AND "workspace_id" IS NULL
      AND "scope_key" = 'platform'
      AND "purpose" = 'platform.channel_crawl'
      AND "request_sha256" ~ '^[0-9a-f]{64}$'
      AND "subject_type" = 'source_channel'
      AND "subject_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "schedule_id" IS NULL
      AND "crawl_run_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "cap_microusd" IS NULL
      AND "cap_per_run_microusd" IS NOT NULL
      AND "cap_per_run_microusd" > 0
      AND "campaign_cap_microusd" IS NOT NULL
      AND "campaign_cap_microusd" > 0
      AND "max_runs" IS NOT NULL
      AND "max_runs" > 0
      AND "runs_consumed" <= "max_runs"
      AND (
        ("runs_consumed" = 0 AND "consumed_at" IS NULL)
        OR ("runs_consumed" > 0 AND "consumed_at" IS NOT NULL)
      )
    )
);

ALTER TABLE "execution_budget_authority"
  DROP CONSTRAINT "execution_budget_authority_admission_lease_check",
  ADD CONSTRAINT "execution_budget_authority_admission_lease_check" CHECK (
    "admission_lease_expires_at" IS NULL
    OR (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND "consumed_at" IS NOT NULL
      AND "admission_lease_expires_at" > "expires_at"
      AND (
        (
          "purpose" = 'discovery.run'
          AND "subject_type" = 'discovery_run'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '3 hours'
        )
        OR (
          "purpose" = 'icp.design'
          AND "subject_type" = 'company'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
        )
        OR (
          "purpose" = 'icp.query_plan'
          AND "subject_type" = 'icp'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
        )
        OR (
          "purpose" = 'understanding.run'
          AND "subject_type" = 'company'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
        )
        OR (
          "purpose" = 'market.candidates.generate'
          AND "subject_type" = 'market_candidate_generation'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
        )
      )
    )
  );

COMMENT ON COLUMN "execution_budget_authority"."admission_lease_expires_at" IS
  'Post-admission validity of a WORKSPACE_GRANT: consumed_at + 3 hours for a discovery run (discovery.run, discovery_run); consumed_at + 30 minutes for ICP design (icp.design, company), ICP query planning (icp.query_plan, icp) company understanding (understanding.run, company) and controlled market candidate generation (market.candidates.generate, market_candidate_generation). NULL keeps expires_at.';

CREATE OR REPLACE FUNCTION consume_workspace_execution_authority(
  p_issuer TEXT,
  p_audience TEXT,
  p_jti UUID,
  p_token_sha256 TEXT,
  p_schema_version TEXT,
  p_purpose "execution_budget_purpose",
  p_workspace_id UUID,
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_request_sha256 TEXT,
  p_currency TEXT,
  p_unit TEXT,
  p_cap_microusd BIGINT,
  p_issued_at TIMESTAMPTZ,
  p_not_before TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE(authority_id UUID, replay BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  time_state TEXT;
  admitted_at TIMESTAMPTZ;
BEGIN
  IF p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR NOT COALESCE(char_length(btrim(p_issuer)) BETWEEN 1 AND 512, false)
    OR p_audience IS DISTINCT FROM 'global-backend:execution-budget'
    OR p_jti IS NULL
    OR NOT COALESCE(p_token_sha256 ~ '^[0-9a-f]{64}$', false)
    OR p_schema_version IS DISTINCT FROM 'execution-budget-grant/v1'
    OR NOT COALESCE(char_length(btrim(p_subject_type)) BETWEEN 1 AND 191, false)
    OR NOT COALESCE(char_length(btrim(p_subject_id)) BETWEEN 1 AND 191, false)
    OR NOT COALESCE(p_request_sha256 ~ '^[0-9a-f]{64}$', false)
    OR p_currency IS DISTINCT FROM 'USD'
    OR p_unit IS DISTINCT FROM 'microusd'
    OR NOT COALESCE(p_cap_microusd > 0, false)
    OR p_issued_at IS NULL
    OR p_not_before IS NULL
    OR p_expires_at IS NULL
    OR NOT COALESCE(p_issued_at <= p_not_before, false)
    OR NOT COALESCE(p_not_before < p_expires_at, false)
    OR NOT COALESCE(
      p_expires_at - p_issued_at <= INTERVAL '5 minutes',
      false
    )
    OR NOT COALESCE((
      (p_purpose = 'understanding.run' AND p_subject_type = 'company')
      OR (p_purpose = 'icp.design' AND p_subject_type = 'company')
      OR (p_purpose = 'icp.query_plan' AND p_subject_type = 'icp')
      OR (
        p_purpose = 'discovery.run'
        AND p_subject_type IN ('discovery_run', 'company')
      )
      OR (p_purpose = 'contact.verify' AND p_subject_type = 'contact_point')
      OR (p_purpose = 'contact.enrich' AND p_subject_type = 'company')
      OR (p_purpose = 'outreach.draft' AND p_subject_type = 'lead')
      OR (p_purpose = 'campaign.plan' AND p_subject_type = 'campaign')
      OR (p_purpose = 'market.candidates.generate' AND p_subject_type = 'market_candidate_generation')
    ), false)
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('execution-budget-jti:' || p_issuer || ':' || p_jti::text, 0)
  );
  SELECT * INTO authority
  FROM "execution_budget_authority"
  WHERE "issuer" = p_issuer AND "jti" = p_jti
  FOR UPDATE;

  IF authority."id" IS NOT NULL THEN
    IF authority."authority_kind" IS DISTINCT FROM 'WORKSPACE_GRANT'
      OR authority."scope_key" IS DISTINCT FROM p_workspace_id::text
      OR authority."audience" IS DISTINCT FROM p_audience
      OR authority."token_sha256" IS DISTINCT FROM p_token_sha256
      OR authority."schema_version" IS DISTINCT FROM p_schema_version
      OR authority."purpose" IS DISTINCT FROM p_purpose
      OR authority."workspace_id" IS DISTINCT FROM p_workspace_id
      OR authority."subject_type" IS DISTINCT FROM p_subject_type
      OR authority."subject_id" IS DISTINCT FROM p_subject_id
      OR authority."request_sha256" IS DISTINCT FROM p_request_sha256
      OR authority."schedule_id" IS NOT NULL
      OR authority."currency" IS DISTINCT FROM p_currency
      OR authority."unit" IS DISTINCT FROM p_unit
      OR authority."cap_microusd" IS DISTINCT FROM p_cap_microusd
      OR authority."cap_per_run_microusd" IS NOT NULL
      OR authority."campaign_cap_microusd" IS NOT NULL
      OR authority."max_runs" IS NOT NULL
      OR authority."issued_at" IS DISTINCT FROM p_issued_at
      OR authority."not_before" IS DISTINCT FROM p_not_before
      OR authority."expires_at" IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT authority."id", true;
    RETURN;
  END IF;

  time_state := execution_budget_authority_time_state(
    p_issued_at,
    p_not_before,
    p_expires_at,
    statement_timestamp()
  );
  IF time_state IN ('INVALID', 'NOT_YET_VALID') THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF time_state = 'EXPIRED' THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_EXPIRED'
      USING ERRCODE = 'P0001';
  END IF;

  admitted_at := clock_timestamp();
  INSERT INTO "execution_budget_authority"(
    "scope_key", "authority_kind", "workspace_id", "issuer", "audience",
    "jti", "token_sha256", "schema_version", "purpose", "subject_type",
    "subject_id", "request_sha256", "currency", "unit", "cap_microusd",
    "issued_at", "not_before", "expires_at", "consumed_at",
    "admission_lease_expires_at"
  ) VALUES (
    p_workspace_id::text, 'WORKSPACE_GRANT', p_workspace_id, p_issuer,
    p_audience, p_jti, p_token_sha256, p_schema_version, p_purpose,
    p_subject_type, p_subject_id, p_request_sha256, p_currency, p_unit,
    p_cap_microusd, p_issued_at, p_not_before, p_expires_at, admitted_at,
    CASE
      WHEN p_purpose = 'discovery.run' AND p_subject_type = 'discovery_run'
        THEN admitted_at + INTERVAL '3 hours'
      WHEN p_purpose = 'icp.design' AND p_subject_type = 'company'
        THEN admitted_at + INTERVAL '30 minutes'
      WHEN p_purpose = 'icp.query_plan' AND p_subject_type = 'icp'
        THEN admitted_at + INTERVAL '30 minutes'
      WHEN p_purpose = 'understanding.run' AND p_subject_type = 'company'
        THEN admitted_at + INTERVAL '30 minutes'
      WHEN p_purpose = 'market.candidates.generate' AND p_subject_type = 'market_candidate_generation'
        THEN admitted_at + INTERVAL '30 minutes'
    END
  ) RETURNING * INTO authority;

  RETURN QUERY SELECT authority."id", false;
END
$$;

COMMIT;

-- CreateTable
CREATE TABLE "market_candidate_generation" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "intent_sequence" BIGINT NOT NULL,
    "prepare_request_hash" VARCHAR(64) NOT NULL,
    "intent_digest" VARCHAR(64) NOT NULL,
    "source_selection" JSONB NOT NULL,
    "basis_descriptors" JSONB NOT NULL,
    "input_material_digest" VARCHAR(64) NOT NULL,
    "contract_version" VARCHAR(100) NOT NULL,
    "contract_digest" VARCHAR(64) NOT NULL,
    "prompt_digest" VARCHAR(64) NOT NULL,
    "input_schema_digest" VARCHAR(64) NOT NULL,
    "output_schema_digest" VARCHAR(64) NOT NULL,
    "model_policy_digest" VARCHAR(64) NOT NULL,
    "expected_current_set_id" UUID,
    "expected_current_revision" INTEGER,
    "prepared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phase" VARCHAR(32) NOT NULL DEFAULT 'PREPARED',
    "reason_code" VARCHAR(40),
    "active_attempt_id" UUID,
    "set_id" UUID,
    "execution_operation_id" UUID,
    "result_schema" VARCHAR(100),
    "result_digest" VARCHAR(64),
    "consumer_ack_id" CHAR(64),
    "consumed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_candidate_generation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_candidate_generation_head" (
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "latest_generation_id" UUID NOT NULL,
    "intent_sequence" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_candidate_generation_head_pkey" PRIMARY KEY ("workspace_id","company_id")
);

-- CreateTable
CREATE TABLE "market_candidate_generation_attempt" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "scope_key" VARCHAR(200) NOT NULL,
    "authority_id" UUID NOT NULL,
    "account_key" VARCHAR(200) NOT NULL,
    "account_generation" INTEGER NOT NULL,
    "expected_operation_key" VARCHAR(64) NOT NULL,
    "request_sha256" VARCHAR(64) NOT NULL,
    "admitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_candidate_generation_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_candidate_generation_company_idx" ON "market_candidate_generation"("workspace_id", "company_id", "prepared_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "market_candidate_generation_identity_key" ON "market_candidate_generation"("id", "workspace_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "market_candidate_generation_head_identity_key" ON "market_candidate_generation"("id", "workspace_id", "company_id", "intent_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "market_candidate_generation_intent_key" ON "market_candidate_generation"("workspace_id", "company_id", "requested_by", "intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "market_candidate_generation_result_set_key" ON "market_candidate_generation"("workspace_id", "company_id", "set_id");

-- CreateIndex
CREATE INDEX "market_candidate_generation_attempt_generation_idx" ON "market_candidate_generation_attempt"("workspace_id", "generation_id", "admitted_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "market_candidate_generation_attempt_identity_key" ON "market_candidate_generation_attempt"("id", "workspace_id", "company_id", "generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "market_candidate_generation_attempt_authority_key" ON "market_candidate_generation_attempt"("generation_id", "authority_id");

-- CreateIndex
CREATE UNIQUE INDEX "market_candidate_generation_attempt_operation_key" ON "market_candidate_generation_attempt"("scope_key", "account_key", "account_generation", "expected_operation_key");

-- AddForeignKey
ALTER TABLE "market_candidate_generation" ADD CONSTRAINT "market_candidate_generation_workspace_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation" ADD CONSTRAINT "market_candidate_generation_company_fkey" FOREIGN KEY ("company_id", "workspace_id") REFERENCES "company_profile"("id", "workspace_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation" ADD CONSTRAINT "market_candidate_generation_active_attempt_fkey" FOREIGN KEY ("active_attempt_id", "workspace_id", "company_id", "id") REFERENCES "market_candidate_generation_attempt"("id", "workspace_id", "company_id", "generation_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation" ADD CONSTRAINT "market_candidate_generation_set_fkey" FOREIGN KEY ("set_id", "workspace_id", "company_id") REFERENCES "market_candidate_set"("id", "workspace_id", "company_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation" ADD CONSTRAINT "market_candidate_generation_anchor_set_fkey" FOREIGN KEY ("expected_current_set_id", "workspace_id", "company_id") REFERENCES "market_candidate_set"("id", "workspace_id", "company_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation" ADD CONSTRAINT "market_candidate_generation_anchor_revision_fkey" FOREIGN KEY ("workspace_id", "expected_current_set_id", "expected_current_revision") REFERENCES "market_candidate_set_revision"("workspace_id", "set_id", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation_head" ADD CONSTRAINT "market_candidate_generation_head_company_fkey" FOREIGN KEY ("company_id", "workspace_id") REFERENCES "company_profile"("id", "workspace_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation_head" ADD CONSTRAINT "market_candidate_generation_head_target_fkey" FOREIGN KEY ("latest_generation_id", "workspace_id", "company_id", "intent_sequence") REFERENCES "market_candidate_generation"("id", "workspace_id", "company_id", "intent_sequence") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation_attempt" ADD CONSTRAINT "market_candidate_generation_attempt_generation_fkey" FOREIGN KEY ("generation_id", "workspace_id", "company_id") REFERENCES "market_candidate_generation"("id", "workspace_id", "company_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation_attempt" ADD CONSTRAINT "market_candidate_generation_attempt_authority_fkey" FOREIGN KEY ("scope_key", "authority_id") REFERENCES "execution_budget_authority"("scope_key", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_candidate_generation_attempt" ADD CONSTRAINT "market_candidate_generation_attempt_account_fkey" FOREIGN KEY ("scope_key", "account_key") REFERENCES "tool_budget_account"("scope_key", "account_key") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Generation controls contain identities, descriptors and digests, never raw input/output.
ALTER TABLE market_candidate_generation
 ADD CONSTRAINT market_candidate_generation_shape CHECK ((
   intent_sequence>0 AND prepare_request_hash ~ '^[0-9a-f]{64}$' AND intent_digest ~ '^[0-9a-f]{64}$'
   AND input_material_digest ~ '^[0-9a-f]{64}$' AND contract_digest ~ '^[0-9a-f]{64}$'
   AND prompt_digest ~ '^[0-9a-f]{64}$' AND input_schema_digest ~ '^[0-9a-f]{64}$'
   AND output_schema_digest ~ '^[0-9a-f]{64}$' AND model_policy_digest ~ '^[0-9a-f]{64}$'
   AND char_length(contract_version) BETWEEN 1 AND 100
   AND jsonb_typeof(source_selection)='object'
   AND source_selection-ARRAY['offeringIds','claimIds']='{}'::jsonb
   AND octet_length(source_selection::text)<=16384
   AND jsonb_typeof(basis_descriptors)='object'
   AND basis_descriptors ?& ARRAY['schemaVersion','company','sources']
   AND basis_descriptors-ARRAY['schemaVersion','company','sources']='{}'::jsonb
   AND basis_descriptors->>'schemaVersion'='market-candidate-generation-basis/v1'
   AND basis_descriptors#>>'{company,companyId}'=company_id::text
   AND jsonb_typeof(basis_descriptors->'sources')='array'
   AND jsonb_array_length(basis_descriptors->'sources') BETWEEN 2 AND 200
   AND octet_length(basis_descriptors::text)<=131072
   AND ((expected_current_set_id IS NULL AND expected_current_revision IS NULL)
     OR (expected_current_set_id IS NOT NULL AND expected_current_revision>=1))
   AND phase IN('PREPARED','RUNNING','RESULT_UNKNOWN','RESULT_READY','PERSISTED','FAILED','NOT_APPLIED')
   AND (reason_code IS NULL OR reason_code IN('BASIS_UNAVAILABLE','BASIS_CHANGED','SUPERSEDED','VERSION_CONFLICT',
      'OUTPUT_INVALID','EXECUTION_REJECTED','EXECUTION_FAILED','RESULT_UNKNOWN','RESULT_NOT_FOUND','SAVE_PENDING'))
   AND (phase IN('PREPARED','FAILED') OR active_attempt_id IS NOT NULL)
 ) IS TRUE),
 ADD CONSTRAINT market_candidate_generation_terminal_shape CHECK ((CASE
   WHEN phase='PERSISTED' THEN set_id IS NOT NULL AND reason_code IS NULL
     AND num_nonnulls(execution_operation_id,result_schema,result_digest,consumer_ack_id,consumed_at)=5
   WHEN phase='NOT_APPLIED' THEN set_id IS NULL
     AND reason_code IN('BASIS_UNAVAILABLE','BASIS_CHANGED','SUPERSEDED','VERSION_CONFLICT')
     AND num_nonnulls(execution_operation_id,result_schema,result_digest,consumer_ack_id,consumed_at)=5
   ELSE set_id IS NULL AND num_nonnulls(execution_operation_id,result_schema,result_digest,consumer_ack_id,consumed_at)=0
 END) IS TRUE);
ALTER TABLE market_candidate_generation_head ADD CONSTRAINT market_candidate_generation_head_sequence CHECK(intent_sequence>0);
ALTER TABLE market_candidate_generation_attempt ADD CONSTRAINT market_candidate_generation_attempt_shape CHECK((
 scope_key=workspace_id::text AND account_generation>0 AND expected_operation_key ~ '^[0-9a-f]{64}$'
 AND request_sha256 ~ '^[0-9a-f]{64}$' AND char_length(account_key) BETWEEN 1 AND 200
) IS TRUE);

CREATE FUNCTION market_candidate_generation_head_step_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.intent_sequence<>1 THEN RAISE EXCEPTION 'MARKET_GENERATION_HEAD_STEP' USING ERRCODE='23514'; END IF;
 ELSIF NEW.intent_sequence<>OLD.intent_sequence+1 OR NEW.latest_generation_id=OLD.latest_generation_id
   OR (to_jsonb(NEW)-ARRAY['latest_generation_id','intent_sequence','updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['latest_generation_id','intent_sequence','updated_at']) THEN
   RAISE EXCEPTION 'MARKET_GENERATION_HEAD_STEP' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER market_candidate_generation_head_step BEFORE INSERT OR UPDATE ON market_candidate_generation_head
 FOR EACH ROW EXECUTE FUNCTION market_candidate_generation_head_step_v1();

CREATE FUNCTION market_candidate_generation_prepared_head_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM market_candidate_generation_head h WHERE h.workspace_id=NEW.workspace_id
   AND h.company_id=NEW.company_id AND h.latest_generation_id=NEW.id AND h.intent_sequence=NEW.intent_sequence) THEN
   RAISE EXCEPTION 'MARKET_GENERATION_PREPARED_HEAD_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER market_candidate_generation_prepared_head AFTER INSERT ON market_candidate_generation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION market_candidate_generation_prepared_head_v1();

CREATE FUNCTION market_candidate_generation_terminal_v1(g market_candidate_generation) RETURNS boolean
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
       AND EXISTS(SELECT 1 FROM market_candidate_generation_head h WHERE h.workspace_id=g.workspace_id
         AND h.company_id=g.company_id AND h.latest_generation_id=g.id AND h.intent_sequence=g.intent_sequence)
     ))
 );
$$;

CREATE FUNCTION market_candidate_generation_lifecycle_v1() RETURNS trigger
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
 IF NEW.phase IN('PERSISTED','NOT_APPLIED') AND NOT market_candidate_generation_terminal_v1(NEW) THEN
   RAISE EXCEPTION 'MARKET_GENERATION_EXACT_TERMINAL_ACK_REQUIRED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER market_candidate_generation_lifecycle BEFORE INSERT OR UPDATE ON market_candidate_generation
 FOR EACH ROW EXECUTE FUNCTION market_candidate_generation_lifecycle_v1();

CREATE FUNCTION market_candidate_generation_attempt_binding_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'MARKET_GENERATION_ATTEMPT_APPEND_ONLY' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM market_candidate_generation g
   JOIN execution_budget_authority r ON r.scope_key=NEW.scope_key AND r.id=NEW.authority_id
   JOIN tool_budget_account b ON b.scope_key=NEW.scope_key AND b.account_key=NEW.account_key
     AND b.authority_id=r.id AND b.generation=NEW.account_generation
   WHERE g.id=NEW.generation_id AND g.workspace_id=NEW.workspace_id AND g.company_id=NEW.company_id
     AND r.workspace_id=g.workspace_id AND r.authority_kind='WORKSPACE_GRANT'
     AND r.purpose='market.candidates.generate' AND r.subject_type='market_candidate_generation'
     AND r.subject_id=g.id::text AND r.request_sha256=NEW.request_sha256
     AND r.cap_microusd=800000 AND b.authorized_cap_microusd=800000
     AND r.consumed_at IS NOT NULL AND r.revoked_at IS NULL AND b.closed_at IS NULL
     AND NEW.request_sha256=encode(public.digest(
       '{"body":{"intentDigest":"'||g.intent_digest||'"},"generationId":"'||g.id::text||
       '","operation":"POST /market-candidate-generations/:generationId/execute"}','sha256'),'hex')
 ) THEN RAISE EXCEPTION 'MARKET_GENERATION_ATTEMPT_BINDING_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER market_candidate_generation_attempt_binding BEFORE INSERT OR UPDATE ON market_candidate_generation_attempt
 FOR EACH ROW EXECUTE FUNCTION market_candidate_generation_attempt_binding_v1();

ALTER TABLE market_candidate_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_candidate_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE market_candidate_generation_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_candidate_generation_head FORCE ROW LEVEL SECURITY;
ALTER TABLE market_candidate_generation_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_candidate_generation_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY market_candidate_generation_workspace ON market_candidate_generation
 USING(workspace_id=current_workspace_id()) WITH CHECK(workspace_id=current_workspace_id());
CREATE POLICY market_candidate_generation_head_workspace ON market_candidate_generation_head
 USING(workspace_id=current_workspace_id()) WITH CHECK(workspace_id=current_workspace_id());
CREATE POLICY market_candidate_generation_attempt_workspace ON market_candidate_generation_attempt
 USING(workspace_id=current_workspace_id()) WITH CHECK(workspace_id=current_workspace_id());
REVOKE ALL ON TABLE market_candidate_generation,market_candidate_generation_head,market_candidate_generation_attempt FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON TABLE market_candidate_generation,market_candidate_generation_head,market_candidate_generation_attempt TO app_user;
GRANT UPDATE(phase,reason_code,active_attempt_id,set_id,updated_at,execution_operation_id,result_schema,result_digest,consumer_ack_id,consumed_at)
 ON TABLE market_candidate_generation TO app_user;
GRANT UPDATE(latest_generation_id,intent_sequence,updated_at) ON TABLE market_candidate_generation_head TO app_user;
REVOKE ALL ON FUNCTION market_candidate_generation_head_step_v1(),market_candidate_generation_prepared_head_v1(),
 market_candidate_generation_lifecycle_v1(),market_candidate_generation_attempt_binding_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION market_candidate_generation_terminal_v1(market_candidate_generation) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION market_candidate_generation_terminal_v1(market_candidate_generation) TO app_user;
