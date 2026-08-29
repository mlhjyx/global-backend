BEGIN;

CREATE TYPE "organization_identifier_status" AS ENUM ('ACTIVE', 'PENDING_CONFLICT', 'REVOKED');
CREATE TYPE "organization_identity_conflict_status" AS ENUM ('OPEN', 'RESOLVING', 'RESOLVED');
CREATE TYPE "organization_identity_decision_action" AS ENUM ('MERGE', 'KEEP_SEPARATE', 'SPLIT');
CREATE TYPE "organization_canonical_mapping_status" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "organization_identity_replay_status" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "identity_link_status" AS ENUM ('ACTIVE', 'PENDING_CONFLICT', 'REVOKED');

CREATE UNIQUE INDEX "canonical_company_workspace_id_id_key"
  ON "canonical_company"("workspace_id", "id");

ALTER TABLE "identity_link"
  ADD COLUMN "status" "identity_link_status",
  ADD COLUMN "resolver_version" VARCHAR(64),
  ADD COLUMN "input_hash" VARCHAR(64),
  ADD COLUMN "conflict_id" UUID;

CREATE INDEX "identity_link_workspace_id_conflict_id_idx"
  ON "identity_link"("workspace_id", "conflict_id");

CREATE TABLE "organization_identifier" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "scheme" VARCHAR(64) NOT NULL,
  "jurisdiction" VARCHAR(64) NOT NULL,
  "normalized_value" VARCHAR(512) NOT NULL,
  "authority_provider_key" VARCHAR(128) NOT NULL,
  "raw_record_id" UUID NOT NULL,
  "conflict_id" UUID,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "normalizer_version" VARCHAR(64) NOT NULL,
  "validator_version" VARCHAR(64) NOT NULL,
  "provenance" JSONB NOT NULL,
  "status" "organization_identifier_status" NOT NULL DEFAULT 'ACTIVE',
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "organization_identifier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_identifier_scheme_not_blank_check"
    CHECK (length(btrim("scheme")) > 0),
  CONSTRAINT "organization_identifier_jurisdiction_not_blank_check"
    CHECK (length(btrim("jurisdiction")) > 0),
  CONSTRAINT "organization_identifier_value_not_blank_check"
    CHECK (length(btrim("normalized_value")) > 0),
  CONSTRAINT "organization_identifier_authority_not_blank_check"
    CHECK (length(btrim("authority_provider_key")) > 0),
  CONSTRAINT "organization_identifier_normalizer_not_blank_check"
    CHECK (length(btrim("normalizer_version")) > 0),
  CONSTRAINT "organization_identifier_validator_not_blank_check"
    CHECK (length(btrim("validator_version")) > 0),
  CONSTRAINT "organization_identifier_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "organization_identifier_revocation_check" CHECK (
    ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)
    OR ("status" <> 'REVOKED' AND "revoked_at" IS NULL)
  ),
  CONSTRAINT "organization_identifier_pending_conflict_owner_check"
    CHECK ("status" <> 'PENDING_CONFLICT' OR "conflict_id" IS NOT NULL)
);

CREATE UNIQUE INDEX "organization_identifier_workspace_id_id_key"
  ON "organization_identifier"("workspace_id", "id");
CREATE UNIQUE INDEX "organization_identifier_active_authority_key"
  ON "organization_identifier"(
    "workspace_id", "scheme", "jurisdiction", "normalized_value"
  )
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "organization_identifier_conflict_claim_key"
  ON "organization_identifier"(
    "workspace_id", "conflict_id", "scheme", "jurisdiction", "normalized_value"
  );
CREATE INDEX "organization_identifier_workspace_id_company_id_status_idx"
  ON "organization_identifier"("workspace_id", "company_id", "status");
CREATE INDEX "org_identifier_lookup_idx"
  ON "organization_identifier"(
    "workspace_id", "scheme", "jurisdiction", "normalized_value"
  );

CREATE TABLE "organization_identity_conflict" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "raw_record_id" UUID,
  "conflict_type" VARCHAR(64) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "status" "organization_identity_conflict_status" NOT NULL DEFAULT 'OPEN',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "facts" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),

  CONSTRAINT "organization_identity_conflict_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_identity_conflict_type_not_blank_check"
    CHECK (length(btrim("conflict_type")) > 0),
  CONSTRAINT "organization_identity_conflict_fingerprint_not_blank_check"
    CHECK (length(btrim("fingerprint")) > 0),
  CONSTRAINT "organization_identity_conflict_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "organization_identity_conflict_resolution_check" CHECK (
    ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL)
    OR ("status" <> 'RESOLVED' AND "resolved_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "organization_identity_conflict_workspace_id_id_key"
  ON "organization_identity_conflict"("workspace_id", "id");
CREATE UNIQUE INDEX "organization_identity_conflict_workspace_fingerprint_key"
  ON "organization_identity_conflict"("workspace_id", "fingerprint");
CREATE INDEX "organization_identity_conflict_workspace_status_created_idx"
  ON "organization_identity_conflict"("workspace_id", "status", "created_at");

CREATE TABLE "organization_identity_conflict_party" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "conflict_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "role" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_identity_conflict_party_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_identity_conflict_party_role_not_blank_check"
    CHECK (length(btrim("role")) > 0)
);

CREATE UNIQUE INDEX "organization_identity_conflict_party_key"
  ON "organization_identity_conflict_party"(
    "workspace_id", "conflict_id", "company_id", "role"
  );
CREATE INDEX "organization_identity_conflict_party_workspace_company_idx"
  ON "organization_identity_conflict_party"("workspace_id", "company_id");

CREATE TABLE "organization_identity_decision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "conflict_id" UUID,
  "action" "organization_identity_decision_action" NOT NULL,
  "canonical_company_id" UUID,
  "request_id" VARCHAR(128) NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "request_precondition_etag" VARCHAR(256) NOT NULL,
  "reason_code" VARCHAR(64) NOT NULL,
  "note" VARCHAR(2000),
  "decided_by" VARCHAR(256) NOT NULL,
  "decision_hash" VARCHAR(64) NOT NULL,
  "fact_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_identity_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_identity_decision_request_not_blank_check"
    CHECK (length(btrim("request_id")) > 0),
  CONSTRAINT "organization_identity_decision_precondition_not_blank_check"
    CHECK (length(btrim("request_precondition_etag")) > 0),
  CONSTRAINT "organization_identity_decision_reason_not_blank_check"
    CHECK (length(btrim("reason_code")) > 0),
  CONSTRAINT "organization_identity_decision_actor_not_blank_check"
    CHECK (length(btrim("decided_by")) > 0),
  CONSTRAINT "organization_identity_decision_hash_not_blank_check"
    CHECK (length(btrim("decision_hash")) > 0),
  CONSTRAINT "organization_identity_decision_revision_check"
    CHECK ("expected_revision" > 0),
  CONSTRAINT "organization_identity_decision_action_target_check" CHECK (
    (
      "action" = 'MERGE'
      AND "conflict_id" IS NOT NULL
      AND "canonical_company_id" IS NOT NULL
    )
    OR (
      "action" = 'KEEP_SEPARATE'
      AND "conflict_id" IS NOT NULL
      AND "canonical_company_id" IS NULL
    )
    OR (
      "action" = 'SPLIT'
      AND "conflict_id" IS NULL
      AND "canonical_company_id" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "organization_identity_decision_workspace_request_key"
  ON "organization_identity_decision"("workspace_id", "request_id");
CREATE UNIQUE INDEX "organization_identity_decision_workspace_id_id_key"
  ON "organization_identity_decision"("workspace_id", "id");

CREATE TABLE "organization_canonical_mapping" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "source_company_id" UUID NOT NULL,
  "canonical_company_id" UUID NOT NULL,
  "status" "organization_canonical_mapping_status" NOT NULL DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "merge_decision_id" UUID NOT NULL,
  "split_decision_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "organization_canonical_mapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_canonical_mapping_not_self_check"
    CHECK ("source_company_id" <> "canonical_company_id"),
  CONSTRAINT "organization_canonical_mapping_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "organization_canonical_mapping_revocation_check" CHECK (
    (
      "status" = 'REVOKED'
      AND "revoked_at" IS NOT NULL
      AND "split_decision_id" IS NOT NULL
    )
    OR (
      "status" = 'ACTIVE'
      AND "revoked_at" IS NULL
      AND "split_decision_id" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "organization_canonical_mapping_workspace_id_id_key"
  ON "organization_canonical_mapping"("workspace_id", "id");
CREATE UNIQUE INDEX "organization_canonical_mapping_active_source_key"
  ON "organization_canonical_mapping"("workspace_id", "source_company_id")
  WHERE "status" = 'ACTIVE';
CREATE INDEX "organization_canonical_mapping_workspace_source_status_idx"
  ON "organization_canonical_mapping"("workspace_id", "source_company_id", "status");
CREATE INDEX "organization_canonical_mapping_workspace_canonical_status_idx"
  ON "organization_canonical_mapping"("workspace_id", "canonical_company_id", "status");

CREATE TABLE "organization_identity_replay" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "decision_id" UUID NOT NULL,
  "status" "organization_identity_replay_status" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "input_hash" VARCHAR(64) NOT NULL,
  "output_hash" VARCHAR(64),
  "error_code" VARCHAR(128),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "organization_identity_replay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_identity_replay_input_hash_not_blank_check"
    CHECK (length(btrim("input_hash")) > 0),
  CONSTRAINT "organization_identity_replay_attempt_check"
    CHECK ("attempt" >= 0),
  CONSTRAINT "organization_identity_replay_completion_check" CHECK (
    ("status" IN ('SUCCEEDED', 'FAILED') AND "completed_at" IS NOT NULL)
    OR ("status" IN ('PENDING', 'RUNNING') AND "completed_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "organization_identity_replay_workspace_decision_key"
  ON "organization_identity_replay"("workspace_id", "decision_id");
CREATE INDEX "organization_identity_replay_workspace_status_created_idx"
  ON "organization_identity_replay"("workspace_id", "status", "created_at");

ALTER TABLE "organization_identifier"
  ADD CONSTRAINT "organization_identifier_company_scope_fkey"
    FOREIGN KEY ("workspace_id", "company_id")
    REFERENCES "canonical_company"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_identifier_raw_scope_fkey"
    FOREIGN KEY ("workspace_id", "raw_record_id")
    REFERENCES "raw_source_record"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_identifier_conflict_scope_fkey"
    FOREIGN KEY ("workspace_id", "conflict_id")
    REFERENCES "organization_identity_conflict"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identity_conflict"
  ADD CONSTRAINT "organization_identity_conflict_raw_scope_fkey"
    FOREIGN KEY ("workspace_id", "raw_record_id")
    REFERENCES "raw_source_record"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identity_conflict_party"
  ADD CONSTRAINT "organization_identity_conflict_party_conflict_scope_fkey"
    FOREIGN KEY ("workspace_id", "conflict_id")
    REFERENCES "organization_identity_conflict"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_identity_conflict_party_company_scope_fkey"
    FOREIGN KEY ("workspace_id", "company_id")
    REFERENCES "canonical_company"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identity_decision"
  ADD CONSTRAINT "organization_identity_decision_conflict_scope_fkey"
    FOREIGN KEY ("workspace_id", "conflict_id")
    REFERENCES "organization_identity_conflict"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_identity_decision_company_scope_fkey"
    FOREIGN KEY ("workspace_id", "canonical_company_id")
    REFERENCES "canonical_company"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_canonical_mapping"
  ADD CONSTRAINT "organization_canonical_mapping_source_scope_fkey"
    FOREIGN KEY ("workspace_id", "source_company_id")
    REFERENCES "canonical_company"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_canonical_mapping_canonical_scope_fkey"
    FOREIGN KEY ("workspace_id", "canonical_company_id")
    REFERENCES "canonical_company"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_canonical_mapping_merge_decision_scope_fkey"
    FOREIGN KEY ("workspace_id", "merge_decision_id")
    REFERENCES "organization_identity_decision"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_canonical_mapping_split_decision_scope_fkey"
    FOREIGN KEY ("workspace_id", "split_decision_id")
    REFERENCES "organization_identity_decision"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identity_replay"
  ADD CONSTRAINT "organization_identity_replay_decision_scope_fkey"
    FOREIGN KEY ("workspace_id", "decision_id")
    REFERENCES "organization_identity_decision"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "identity_link"
  ADD CONSTRAINT "identity_link_conflict_scope_fkey"
    FOREIGN KEY ("workspace_id", "conflict_id")
    REFERENCES "organization_identity_conflict"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identifier" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identifier_tenant_isolation" ON "organization_identifier"
  FOR ALL
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_identity_conflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_conflict" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identity_conflict_tenant_isolation" ON "organization_identity_conflict"
  FOR ALL
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_identity_conflict_party" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_conflict_party" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identity_conflict_party_tenant_isolation" ON "organization_identity_conflict_party"
  FOR ALL
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_identity_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_decision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identity_decision_tenant_isolation" ON "organization_identity_decision"
  FOR ALL
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_canonical_mapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_canonical_mapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_canonical_mapping_tenant_isolation" ON "organization_canonical_mapping"
  FOR ALL
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_identity_replay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_replay" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identity_replay_tenant_isolation" ON "organization_identity_replay"
  FOR ALL
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "organization_identifier" FROM PUBLIC, app_user;
GRANT SELECT ON TABLE "organization_identifier" TO app_user;
REVOKE ALL ON TABLE "organization_identity_conflict" FROM PUBLIC, app_user;
GRANT SELECT ON TABLE "organization_identity_conflict" TO app_user;
REVOKE ALL ON TABLE "organization_identity_conflict_party" FROM PUBLIC, app_user;
GRANT SELECT ON TABLE "organization_identity_conflict_party" TO app_user;
REVOKE ALL ON TABLE "organization_identity_decision" FROM PUBLIC, app_user;
GRANT SELECT ON TABLE "organization_identity_decision" TO app_user;
REVOKE ALL ON TABLE "organization_canonical_mapping" FROM PUBLIC, app_user;
GRANT SELECT ON TABLE "organization_canonical_mapping" TO app_user;
REVOKE ALL ON TABLE "organization_identity_replay" FROM PUBLIC, app_user;
GRANT SELECT ON TABLE "organization_identity_replay" TO app_user;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "identity_link" FROM app_user;
REVOKE UPDATE (
  "id", "workspace_id", "canonical_type", "canonical_id", "raw_record_id",
  "match_rule", "confidence", "created_at", "status", "resolver_version",
  "input_hash", "conflict_id"
) ON TABLE "identity_link" FROM app_user;
REVOKE REFERENCES (
  "id", "workspace_id", "canonical_type", "canonical_id", "raw_record_id",
  "match_rule", "confidence", "created_at", "status", "resolver_version",
  "input_hash", "conflict_id"
) ON TABLE "identity_link" FROM app_user;
REVOKE INSERT ON TABLE "identity_link" FROM app_user;
GRANT INSERT ("id", "workspace_id", "canonical_type", "canonical_id", "raw_record_id", "match_rule", "confidence") ON TABLE "identity_link" TO app_user;
GRANT SELECT ON TABLE "identity_link" TO app_user;

COMMIT;
