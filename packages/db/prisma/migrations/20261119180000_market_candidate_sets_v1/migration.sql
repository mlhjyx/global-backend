CREATE TABLE "market_candidate_set" (
  "id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "current_revision" integer NOT NULL DEFAULT 1 CHECK ("current_revision" > 0),
  "initial_operation_id" uuid NOT NULL,
  "initial_request_hash" varchar(64) NOT NULL CHECK ("initial_request_hash" ~ '^[a-f0-9]{64}$'),
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "market_candidate_set_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "market_candidate_set_identity_key" UNIQUE ("id", "workspace_id", "company_id"),
  CONSTRAINT "market_candidate_set_operation_key" UNIQUE ("workspace_id", "company_id", "initial_operation_id"),
  CONSTRAINT "market_candidate_set_workspace_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "market_candidate_set_company_fkey" FOREIGN KEY ("company_id", "workspace_id") REFERENCES "company_profile"("id", "workspace_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "market_candidate_set_company_created_idx" ON "market_candidate_set"("workspace_id", "company_id", "created_at", "id");

CREATE TABLE "market_candidate_set_revision" (
  "workspace_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "set_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "parent_revision" integer,
  "document_json" jsonb NOT NULL,
  "document_hash" varchar(64) NOT NULL CHECK ("document_hash" ~ '^[a-f0-9]{64}$'),
  "created_by" uuid NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "market_candidate_set_revision_pkey" PRIMARY KEY ("workspace_id", "set_id", "revision"),
  CONSTRAINT "market_candidate_revision_parent_check" CHECK ((("revision"=1 AND "parent_revision" IS NULL) OR ("revision">1 AND "parent_revision"="revision"-1)) IS TRUE),
  CONSTRAINT "market_candidate_revision_document_check" CHECK ((
    jsonb_typeof("document_json")='object' AND octet_length("document_json"::text)<=262144
    AND "document_json"->>'schemaVersion'='market-candidate-set/v1'
    AND "document_json"->>'setId'="set_id"::text AND "document_json"->>'companyId'="company_id"::text
    AND "document_json"->'revision'=to_jsonb("revision")
    AND jsonb_typeof("document_json"->'candidates')='array'
    AND jsonb_array_length("document_json"->'candidates')<=100
    AND jsonb_typeof("document_json"->'basisSnapshot')='object'
    AND jsonb_typeof("document_json"->'basisSnapshot'->'sources')='array'
    AND jsonb_array_length("document_json"->'basisSnapshot'->'sources')<=200
    AND (("document_json"->>'generationOutcome'='COMPLETED_EMPTY' AND jsonb_array_length("document_json"->'candidates')=0)
      OR ("document_json"->>'generationOutcome'='CANDIDATES_PROPOSED' AND jsonb_array_length("document_json"->'candidates')>0))
  ) IS TRUE),
  CONSTRAINT "market_candidate_revision_set_fkey" FOREIGN KEY ("set_id", "workspace_id", "company_id") REFERENCES "market_candidate_set"("id", "workspace_id", "company_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "market_candidate_revision_parent_fkey" FOREIGN KEY ("workspace_id", "set_id", "parent_revision") REFERENCES "market_candidate_set_revision"("workspace_id", "set_id", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE "market_candidate_set" ADD CONSTRAINT "market_candidate_set_current_fkey"
  FOREIGN KEY ("workspace_id", "id", "current_revision") REFERENCES "market_candidate_set_revision"("workspace_id", "set_id", "revision")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "market_candidate_feedback" (
  "id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "set_id" uuid NOT NULL,
  "candidate_id" uuid NOT NULL,
  "from_revision" integer NOT NULL CHECK ("from_revision">0),
  "to_revision" integer NOT NULL,
  "action" varchar(20) NOT NULL CHECK ("action" IN ('CONFIRM','CORRECT','KEEP_PENDING','REJECT')),
  "reason" varchar(2000),
  "correction" jsonb,
  "before_json" jsonb NOT NULL CHECK (jsonb_typeof("before_json")='object' AND octet_length("before_json"::text)<=262144),
  "after_json" jsonb NOT NULL CHECK (jsonb_typeof("after_json")='object' AND octet_length("after_json"::text)<=262144),
  "actor_id" uuid NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotency_key" uuid NOT NULL,
  "request_hash" varchar(64) NOT NULL CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "market_candidate_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "market_candidate_feedback_key" UNIQUE ("workspace_id", "set_id", "actor_id", "idempotency_key"),
  CONSTRAINT "market_candidate_feedback_revision_key" UNIQUE ("workspace_id", "set_id", "to_revision"),
  CONSTRAINT "market_candidate_feedback_step_check" CHECK ("to_revision"="from_revision"+1),
  CONSTRAINT "market_candidate_feedback_patch_check" CHECK (
    ("action"='CORRECT' AND "correction" IS NOT NULL AND jsonb_typeof("correction")='object' AND "correction"<>'{}'::jsonb AND octet_length("correction"::text)<=262144)
    OR ("action"<>'CORRECT' AND "correction" IS NULL)
  ),
  CONSTRAINT "market_candidate_feedback_set_fkey" FOREIGN KEY ("set_id", "workspace_id", "company_id") REFERENCES "market_candidate_set"("id", "workspace_id", "company_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "market_candidate_feedback_from_fkey" FOREIGN KEY ("workspace_id", "set_id", "from_revision") REFERENCES "market_candidate_set_revision"("workspace_id", "set_id", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "market_candidate_feedback_to_fkey" FOREIGN KEY ("workspace_id", "set_id", "to_revision") REFERENCES "market_candidate_set_revision"("workspace_id", "set_id", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION "market_candidate_head_step_v1"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.current_revision<>1 THEN RAISE EXCEPTION 'MARKET_CANDIDATE_REVISION_STEP' USING ERRCODE='23514'; END IF;
  ELSIF NEW.current_revision<>OLD.current_revision+1 OR
    (to_jsonb(NEW)-'current_revision'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'current_revision'-'updated_at') THEN
    RAISE EXCEPTION 'MARKET_CANDIDATE_REVISION_STEP' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "market_candidate_head_step" BEFORE INSERT OR UPDATE ON "market_candidate_set" FOR EACH ROW EXECUTE FUNCTION "market_candidate_head_step_v1"();

CREATE FUNCTION "market_candidate_complete_v1"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  target_id uuid;
  head_revision integer;
  revision_count bigint;
  feedback_count bigint;
  max_revision integer;
BEGIN
  IF TG_TABLE_NAME='market_candidate_set' THEN target_id:=NEW.id; ELSE target_id:=NEW.set_id; END IF;
  SELECT current_revision INTO head_revision FROM public.market_candidate_set WHERE id=target_id AND workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT count(*),max(revision) INTO revision_count,max_revision FROM public.market_candidate_set_revision WHERE set_id=target_id AND workspace_id=NEW.workspace_id;
  SELECT count(*) INTO feedback_count FROM public.market_candidate_feedback WHERE set_id=target_id AND workspace_id=NEW.workspace_id;
  IF revision_count<>head_revision OR max_revision IS DISTINCT FROM head_revision OR feedback_count<>head_revision-1 THEN
    RAISE EXCEPTION 'MARKET_CANDIDATE_INCOMPLETE_REVISION' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.market_candidate_feedback f
    JOIN public.market_candidate_set_revision r ON r.workspace_id=f.workspace_id AND r.set_id=f.set_id AND r.revision=f.to_revision
    JOIN public.market_candidate_set_revision p ON p.workspace_id=f.workspace_id AND p.set_id=f.set_id AND p.revision=f.from_revision
    WHERE f.set_id=target_id AND f.workspace_id=NEW.workspace_id AND (
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.document_json->'candidates') c WHERE c->>'candidateId'=f.candidate_id::text)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.document_json->'candidates') c WHERE c->>'candidateId'=f.candidate_id::text)
    )
  ) THEN RAISE EXCEPTION 'MARKET_CANDIDATE_FEEDBACK_TARGET_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "market_candidate_set_complete" AFTER INSERT OR UPDATE ON "market_candidate_set" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "market_candidate_complete_v1"();
CREATE CONSTRAINT TRIGGER "market_candidate_revision_complete" AFTER INSERT ON "market_candidate_set_revision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "market_candidate_complete_v1"();
CREATE CONSTRAINT TRIGGER "market_candidate_feedback_complete" AFTER INSERT ON "market_candidate_feedback" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "market_candidate_complete_v1"();
REVOKE ALL ON FUNCTION "market_candidate_head_step_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "market_candidate_complete_v1"() FROM PUBLIC;

ALTER TABLE "market_candidate_set" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_candidate_set" FORCE ROW LEVEL SECURITY;
ALTER TABLE "market_candidate_set_revision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_candidate_set_revision" FORCE ROW LEVEL SECURITY;
ALTER TABLE "market_candidate_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_candidate_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY "market_candidate_set_workspace" ON "market_candidate_set" USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY "market_candidate_revision_workspace" ON "market_candidate_set_revision" USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY "market_candidate_feedback_workspace" ON "market_candidate_feedback" USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
REVOKE ALL ON TABLE "market_candidate_set","market_candidate_set_revision","market_candidate_feedback" FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON TABLE "market_candidate_set","market_candidate_set_revision","market_candidate_feedback" TO app_user;
GRANT UPDATE ("current_revision","updated_at") ON TABLE "market_candidate_set" TO app_user;
