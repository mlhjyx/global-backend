-- Immutable company identity-resolution decisions. This migration records
-- provenance only and intentionally never updates canonical_company evidence.

CREATE TYPE "identity_resolution_decision_kind" AS ENUM (
  'AUTO_LINK',
  'REVIEW_LINK',
  'REJECT_LINK',
  'SPLIT'
);

CREATE UNIQUE INDEX "canonical_company_id_workspace_key"
  ON "canonical_company"("id", "workspace_id");

CREATE FUNCTION "identity_resolution_evidence_refs_valid"(refs JSONB)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_typeof(refs) = 'array'
    AND jsonb_array_length(refs) BETWEEN 1 AND 32
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(refs) AS item
      WHERE jsonb_typeof(item) <> 'object'
        OR item ?| ARRAY['workspace_id', 'actor_id', 'value', 'payload']
        OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 2
        OR item->>'type' NOT IN ('FIELD_EVIDENCE', 'RAW_RECORD', 'SOURCE_SIGNAL')
        OR COALESCE(item->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );
$$;

REVOKE ALL ON FUNCTION "identity_resolution_evidence_refs_valid"(JSONB) FROM PUBLIC;

CREATE TABLE "identity_resolution_decision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "canonical_company_id" UUID NOT NULL,
  "linked_canonical_company_id" UUID,
  "decision" "identity_resolution_decision_kind" NOT NULL,
  "rule_version" VARCHAR(128) NOT NULL,
  "evidence_refs" JSONB NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" VARCHAR(255) NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "identity_resolution_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_resolution_decision_no_self_link_check" CHECK (
    "linked_canonical_company_id" IS NULL
    OR "linked_canonical_company_id" <> "canonical_company_id"
  ),
  CONSTRAINT "identity_resolution_decision_rule_version_check" CHECK (
    char_length("rule_version") BETWEEN 1 AND 128
    AND "rule_version" ~ '^[a-z0-9][a-z0-9._/-]*$'
  ),
  CONSTRAINT "identity_resolution_decision_evidence_check" CHECK (
    "identity_resolution_evidence_refs_valid"("evidence_refs")
  ),
  CONSTRAINT "identity_resolution_decision_actor_check" CHECK (
    ("decision" = 'AUTO_LINK' AND "actor_type" = 'SYSTEM')
    OR ("decision" <> 'AUTO_LINK' AND "actor_type" = 'USER')
  ),
  CONSTRAINT "identity_resolution_decision_link_semantics_check" CHECK (
    ("decision" = 'REVIEW_LINK' AND "linked_canonical_company_id" IS NOT NULL)
    OR ("decision" IN ('AUTO_LINK', 'REJECT_LINK', 'SPLIT'))
  ),
  CONSTRAINT "identity_resolution_decision_source_scope_fkey"
    FOREIGN KEY ("canonical_company_id", "workspace_id")
    REFERENCES "canonical_company"("id", "workspace_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "identity_resolution_decision_target_scope_fkey"
    FOREIGN KEY ("linked_canonical_company_id", "workspace_id")
    REFERENCES "canonical_company"("id", "workspace_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "identity_resolution_decision_company_history_idx"
  ON "identity_resolution_decision"(
    "workspace_id", "canonical_company_id", "decided_at", "id"
  );
CREATE INDEX "identity_resolution_decision_target_idx"
  ON "identity_resolution_decision"(
    "workspace_id", "linked_canonical_company_id"
  );

CREATE FUNCTION "reject_identity_resolution_decision_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'identity resolution decisions are append-only'
    USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION "reject_identity_resolution_decision_mutation"() FROM PUBLIC;
CREATE TRIGGER "reject_identity_resolution_decision_mutation"
BEFORE UPDATE OR DELETE ON "identity_resolution_decision"
FOR EACH ROW EXECUTE FUNCTION "reject_identity_resolution_decision_mutation"();

ALTER TABLE "identity_resolution_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity_resolution_decision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "identity_resolution_decision_tenant_isolation"
  ON "identity_resolution_decision"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "identity_resolution_decision" FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE "identity_resolution_decision" TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "identity_resolution_decision" FROM app_user;
