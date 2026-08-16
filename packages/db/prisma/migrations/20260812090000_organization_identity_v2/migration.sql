-- Identity v2 is additive and intentionally does not backfill existing companies.
-- Legacy dedupe_key remains a blocking key; authoritative identifiers are learned lazily.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Tenant tables already use FORCE RLS. Migration deployment must either run
-- with a superuser/BYPASSRLS role or fail here instead of silently seeing zero
-- legacy rows and letting the later foreign-key validation fail opaquely.
SET LOCAL row_security = off;

LOCK TABLE "identity_link", "raw_source_record", "canonical_company",
  "field_evidence", "source_entity", "monitored_source"
  IN SHARE ROW EXCLUSIVE MODE;

-- Older monitored-source projection stored source_entity.id directly in the
-- polymorphic raw_record_id column. Preserve that evidence as an explicit
-- legacy bridge Raw row before enforcing the new RawSourceRecord foreign key.
ALTER TABLE "raw_source_record"
  ALTER COLUMN "run_id" DROP NOT NULL,
  ADD COLUMN "source_entity_id" UUID;

ALTER TABLE "raw_source_record"
  ADD CONSTRAINT "raw_source_record_source_entity_fkey"
  FOREIGN KEY ("source_entity_id")
  REFERENCES "source_entity"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

INSERT INTO "raw_source_record" (
  "id", "workspace_id", "run_id", "source_entity_id", "provider_key",
  "source_class", "external_id", "payload", "cost_cents", "created_at"
)
SELECT
  gen_random_uuid(), legacy."workspace_id", NULL, legacy."source_entity_id",
  source."provider_key", 'monitored_source_legacy',
  'legacy-monitored:' || legacy."source_entity_id"::text,
  jsonb_build_object(
    '_rawReceipt', 'legacy-source-entity/v1',
    'originKind', 'monitored_source_projection',
    'provenanceLevel', 'legacy_reference_only',
    'sourceEntityId', entity."id",
    'sourceKey', source."source_key",
    'externalId', entity."external_id",
    'contentHash', entity."content_hash",
    'firstSeenAt', entity."first_seen_at",
    'observedAt', entity."last_seen_at"
  ),
  0,
  entity."created_at"
FROM (
  SELECT DISTINCT candidate."workspace_id", candidate."raw_record_id" AS "source_entity_id"
  FROM (
    SELECT "workspace_id", "raw_record_id" FROM "identity_link"
    UNION
    SELECT "workspace_id", "raw_record_id" FROM "field_evidence"
    WHERE "raw_record_id" IS NOT NULL
  ) candidate
  LEFT JOIN "raw_source_record" raw
    ON raw."workspace_id" = candidate."workspace_id"
   AND raw."id" = candidate."raw_record_id"
  JOIN "source_entity" entity ON entity."id" = candidate."raw_record_id"
  WHERE raw."id" IS NULL
) legacy
JOIN "source_entity" entity ON entity."id" = legacy."source_entity_id"
JOIN "monitored_source" source ON source."id" = entity."source_id";

UPDATE "identity_link" link
SET "raw_record_id" = raw."id"
FROM "raw_source_record" raw
WHERE raw."workspace_id" = link."workspace_id"
  AND raw."source_entity_id" = link."raw_record_id"
  AND NOT EXISTS (
    SELECT 1 FROM "raw_source_record" current_raw
    WHERE current_raw."workspace_id" = link."workspace_id"
      AND current_raw."id" = link."raw_record_id"
  );

UPDATE "field_evidence" evidence
SET "raw_record_id" = raw."id"
FROM "raw_source_record" raw
WHERE raw."workspace_id" = evidence."workspace_id"
  AND raw."source_entity_id" = evidence."raw_record_id"
  AND NOT EXISTS (
    SELECT 1 FROM "raw_source_record" current_raw
    WHERE current_raw."workspace_id" = evidence."workspace_id"
      AND current_raw."id" = evidence."raw_record_id"
  );

CREATE TYPE "organization_identifier_status" AS ENUM ('ACTIVE', 'PENDING_CONFLICT', 'REVOKED');
CREATE TYPE "organization_identity_conflict_status" AS ENUM ('OPEN', 'RESOLVING', 'RESOLVED');
CREATE TYPE "organization_identity_decision_action" AS ENUM ('MERGE', 'KEEP_SEPARATE', 'SPLIT');
CREATE TYPE "organization_canonical_mapping_status" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "organization_identity_replay_status" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "identity_link_status" AS ENUM ('ACTIVE', 'PENDING_CONFLICT', 'REVOKED');

-- Composite tenant keys let every new foreign key prove workspace equality in PostgreSQL.
CREATE UNIQUE INDEX "raw_source_record_workspace_id_id_key"
  ON "raw_source_record"("workspace_id", "id");
CREATE UNIQUE INDEX "canonical_company_workspace_id_id_key"
  ON "canonical_company"("workspace_id", "id");

-- Existing links predate a foreign key. Refuse the migration if legacy data is corrupt rather than silently deleting it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "identity_link" link
    LEFT JOIN "raw_source_record" raw
      ON raw."workspace_id" = link."workspace_id"
     AND raw."id" = link."raw_record_id"
    WHERE raw."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'identity_link contains an unresolvable missing or cross-workspace raw record';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "identity_link"
    GROUP BY "workspace_id", "canonical_type", "canonical_id", "raw_record_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'identity_link contains duplicate canonical/raw bindings';
  END IF;
END;
$$;

ALTER TABLE "identity_link"
  ADD COLUMN "status" "identity_link_status" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "resolver_version" TEXT NOT NULL DEFAULT 'identity-v1',
  ADD COLUMN "input_hash" VARCHAR(64) NOT NULL DEFAULT 'legacy',
  ADD COLUMN "conflict_id" UUID;

CREATE UNIQUE INDEX "identity_link_workspace_canonical_raw_key"
  ON "identity_link"("workspace_id", "canonical_type", "canonical_id", "raw_record_id");
CREATE INDEX "identity_link_workspace_id_conflict_id_idx"
  ON "identity_link"("workspace_id", "conflict_id");

CREATE TABLE "organization_identifier" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "scheme" VARCHAR(64) NOT NULL,
  "jurisdiction" VARCHAR(64) NOT NULL DEFAULT '',
  "normalized_value" VARCHAR(512) NOT NULL,
  "authority_provider_key" VARCHAR(128) NOT NULL,
  "raw_record_id" UUID,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "normalizer_version" VARCHAR(64) NOT NULL,
  "validator_version" VARCHAR(64) NOT NULL,
  "status" "organization_identifier_status" NOT NULL DEFAULT 'ACTIVE',
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "organization_identifier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_identifier_value_not_blank_check" CHECK (length(btrim("normalized_value")) > 0),
  CONSTRAINT "organization_identifier_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "organization_identifier_revocation_check" CHECK (
    ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)
    OR ("status" <> 'REVOKED' AND "revoked_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "organization_identifier_workspace_id_id_key"
  ON "organization_identifier"("workspace_id", "id");
CREATE UNIQUE INDEX "organization_identifier_active_authority_key"
  ON "organization_identifier"("workspace_id", "scheme", "jurisdiction", "normalized_value")
  WHERE "status" = 'ACTIVE';
CREATE INDEX "organization_identifier_workspace_id_company_id_status_idx"
  ON "organization_identifier"("workspace_id", "company_id", "status");
CREATE INDEX "org_identifier_lookup_idx"
  ON "organization_identifier"("workspace_id", "scheme", "jurisdiction", "normalized_value");

CREATE TABLE "organization_identity_conflict" (
  "id" UUID NOT NULL,
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
  CONSTRAINT "organization_identity_conflict_revision_check" CHECK ("revision" > 0),
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
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "conflict_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "role" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_identity_conflict_party_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_identity_conflict_party_key"
  ON "organization_identity_conflict_party"("workspace_id", "conflict_id", "company_id", "role");
CREATE INDEX "organization_identity_conflict_party_workspace_company_idx"
  ON "organization_identity_conflict_party"("workspace_id", "company_id");

CREATE TABLE "organization_identity_decision" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "conflict_id" UUID,
  "action" "organization_identity_decision_action" NOT NULL,
  "canonical_company_id" UUID,
  "request_id" VARCHAR(128) NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "reason_code" VARCHAR(64) NOT NULL,
  "note" VARCHAR(2000),
  "decided_by" VARCHAR(256) NOT NULL,
  "decision_hash" VARCHAR(64) NOT NULL,
  "fact_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_identity_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_identity_decision_revision_check" CHECK ("expected_revision" > 0),
  CONSTRAINT "organization_identity_decision_action_target_check" CHECK (
    ("action" = 'MERGE' AND "canonical_company_id" IS NOT NULL)
    OR "action" IN ('KEEP_SEPARATE', 'SPLIT')
  )
);

CREATE UNIQUE INDEX "organization_identity_decision_workspace_request_key"
  ON "organization_identity_decision"("workspace_id", "request_id");
CREATE UNIQUE INDEX "organization_identity_decision_workspace_id_id_key"
  ON "organization_identity_decision"("workspace_id", "id");
CREATE INDEX "organization_identity_decision_workspace_conflict_created_idx"
  ON "organization_identity_decision"("workspace_id", "conflict_id", "created_at");

CREATE TABLE "organization_canonical_mapping" (
  "id" UUID NOT NULL,
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
  CONSTRAINT "organization_canonical_mapping_not_self_check" CHECK ("source_company_id" <> "canonical_company_id"),
  CONSTRAINT "organization_canonical_mapping_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "organization_canonical_mapping_revocation_check" CHECK (
    ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL AND "split_decision_id" IS NOT NULL)
    OR ("status" = 'ACTIVE' AND "revoked_at" IS NULL AND "split_decision_id" IS NULL)
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
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "decision_id" UUID NOT NULL,
  "status" "organization_identity_replay_status" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "input_hash" VARCHAR(64) NOT NULL,
  "output_hash" VARCHAR(64),
  "error_code" VARCHAR(128),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "organization_identity_replay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_identity_replay_attempt_check" CHECK ("attempt" >= 0),
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
  REFERENCES "canonical_company"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_identifier_raw_scope_fkey"
  FOREIGN KEY ("workspace_id", "raw_record_id")
  REFERENCES "raw_source_record"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identity_conflict"
  ADD CONSTRAINT "organization_identity_conflict_raw_scope_fkey"
  FOREIGN KEY ("workspace_id", "raw_record_id")
  REFERENCES "raw_source_record"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identity_conflict_party"
  ADD CONSTRAINT "organization_identity_conflict_party_conflict_scope_fkey"
  FOREIGN KEY ("workspace_id", "conflict_id")
  REFERENCES "organization_identity_conflict"("workspace_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_identity_conflict_party_company_scope_fkey"
  FOREIGN KEY ("workspace_id", "company_id")
  REFERENCES "canonical_company"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identity_decision"
  ADD CONSTRAINT "organization_identity_decision_conflict_scope_fkey"
  FOREIGN KEY ("workspace_id", "conflict_id")
  REFERENCES "organization_identity_conflict"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_identity_decision_company_scope_fkey"
  FOREIGN KEY ("workspace_id", "canonical_company_id")
  REFERENCES "canonical_company"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_canonical_mapping"
  ADD CONSTRAINT "organization_canonical_mapping_source_scope_fkey"
  FOREIGN KEY ("workspace_id", "source_company_id")
  REFERENCES "canonical_company"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_canonical_mapping_canonical_scope_fkey"
  FOREIGN KEY ("workspace_id", "canonical_company_id")
  REFERENCES "canonical_company"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_canonical_mapping_merge_decision_scope_fkey"
  FOREIGN KEY ("workspace_id", "merge_decision_id")
  REFERENCES "organization_identity_decision"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "organization_canonical_mapping_split_decision_scope_fkey"
  FOREIGN KEY ("workspace_id", "split_decision_id")
  REFERENCES "organization_identity_decision"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "organization_identity_replay"
  ADD CONSTRAINT "organization_identity_replay_decision_scope_fkey"
  FOREIGN KEY ("workspace_id", "decision_id")
  REFERENCES "organization_identity_decision"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "identity_link"
  ADD CONSTRAINT "identity_link_raw_scope_fkey"
  FOREIGN KEY ("workspace_id", "raw_record_id")
  REFERENCES "raw_source_record"("workspace_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "identity_link_conflict_scope_fkey"
  FOREIGN KEY ("workspace_id", "conflict_id")
  REFERENCES "organization_identity_conflict"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Serialize mappings per workspace and prohibit aliases pointing at aliases, cycles, or multiple active roots.
CREATE OR REPLACE FUNCTION enforce_organization_mapping_root()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."workspace_id"::text, 0));

  IF EXISTS (
    SELECT 1 FROM "organization_canonical_mapping"
    WHERE "workspace_id" = NEW."workspace_id"
      AND "status" = 'ACTIVE'
      AND "source_company_id" = NEW."canonical_company_id"
      AND "id" <> NEW."id"
  ) THEN
    RAISE EXCEPTION 'canonical target must be a root company';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "organization_canonical_mapping"
    WHERE "workspace_id" = NEW."workspace_id"
      AND "status" = 'ACTIVE'
      AND "canonical_company_id" = NEW."source_company_id"
      AND "id" <> NEW."id"
  ) THEN
    RAISE EXCEPTION 'company with active aliases cannot become an alias without re-rooting them';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "organization_canonical_mapping_root_guard"
BEFORE INSERT OR UPDATE ON "organization_canonical_mapping"
FOR EACH ROW EXECUTE FUNCTION enforce_organization_mapping_root();

CREATE OR REPLACE FUNCTION reject_organization_identity_decision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'organization identity decisions are append-only';
END;
$$;

CREATE TRIGGER "organization_identity_decision_append_only_guard"
BEFORE UPDATE OR DELETE ON "organization_identity_decision"
FOR EACH ROW EXECUTE FUNCTION reject_organization_identity_decision_mutation();

-- Identity facts are revoked/resolved through state transitions. Physical deletion would erase
-- the evidence needed to explain a later merge, split, conflict resolution, or deterministic replay.
CREATE OR REPLACE FUNCTION reject_organization_identity_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'organization identity history cannot be physically deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "organization_identifier_delete_guard"
BEFORE DELETE ON "organization_identifier"
FOR EACH ROW EXECUTE FUNCTION reject_organization_identity_delete();

CREATE TRIGGER "organization_identity_conflict_delete_guard"
BEFORE DELETE ON "organization_identity_conflict"
FOR EACH ROW EXECUTE FUNCTION reject_organization_identity_delete();

CREATE TRIGGER "organization_identity_conflict_party_delete_guard"
BEFORE DELETE ON "organization_identity_conflict_party"
FOR EACH ROW EXECUTE FUNCTION reject_organization_identity_delete();

CREATE TRIGGER "organization_canonical_mapping_delete_guard"
BEFORE DELETE ON "organization_canonical_mapping"
FOR EACH ROW EXECUTE FUNCTION reject_organization_identity_delete();

CREATE TRIGGER "organization_identity_replay_delete_guard"
BEFORE DELETE ON "organization_identity_replay"
FOR EACH ROW EXECUTE FUNCTION reject_organization_identity_delete();

ALTER TABLE "organization_identifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identifier" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identifier_tenant_isolation" ON "organization_identifier"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_identity_conflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_conflict" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identity_conflict_tenant_isolation" ON "organization_identity_conflict"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_identity_conflict_party" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_conflict_party" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identity_conflict_party_tenant_isolation" ON "organization_identity_conflict_party"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_identity_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_decision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identity_decision_tenant_isolation" ON "organization_identity_decision"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_canonical_mapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_canonical_mapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_canonical_mapping_tenant_isolation" ON "organization_canonical_mapping"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "organization_identity_replay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_replay" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_identity_replay_tenant_isolation" ON "organization_identity_replay"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON TABLE
  "organization_identifier",
  "organization_identity_conflict",
  "organization_identity_conflict_party",
  "organization_canonical_mapping",
  "organization_identity_replay"
TO app_user;

GRANT SELECT, INSERT ON TABLE "organization_identity_decision" TO app_user;
REVOKE UPDATE, DELETE ON TABLE "organization_identity_decision" FROM app_user;
REVOKE DELETE ON TABLE
  "organization_identifier",
  "organization_identity_conflict",
  "organization_identity_conflict_party",
  "organization_canonical_mapping",
  "organization_identity_replay"
FROM app_user;

COMMIT;
