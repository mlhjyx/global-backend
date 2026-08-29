BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

LOCK TABLE "canonical_company" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "canonical_contact" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "raw_source_record" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "organization_identity_conflict" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "organization_identity_decision" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "organization_identifier" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "organization_canonical_mapping" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "organization_identity_replay" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "organization_identity_conflict_party" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "identity_link" IN SHARE ROW EXCLUSIVE MODE;

DO $identity_link_contract_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."identity_link"
    WHERE "status" IS NULL
      OR "resolver_version" IS NULL
      OR "input_hash" IS NULL
      OR (
        "input_hash" <> 'legacy'
        AND "input_hash" !~ '^[0-9a-f]{64}$'
      )
      OR ("status" = 'PENDING_CONFLICT' AND "conflict_id" IS NULL)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'IDENTITY_LINK_CONTRACT_PREFLIGHT_LIFECYCLE_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."identity_link"
    GROUP BY "workspace_id", "canonical_type", "canonical_id", "raw_record_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'IDENTITY_LINK_CONTRACT_PREFLIGHT_DUPLICATE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."identity_link" AS link
    WHERE link."canonical_type" NOT IN ('company', 'contact')
      OR (
        link."canonical_type" = 'company'
        AND NOT EXISTS (
          SELECT 1
          FROM public."canonical_company" AS company
          WHERE company."workspace_id" = link."workspace_id"
            AND company."id" = link."canonical_id"
        )
      )
      OR (
        link."canonical_type" = 'contact'
        AND NOT EXISTS (
          SELECT 1
          FROM public."canonical_contact" AS contact
          WHERE contact."workspace_id" = link."workspace_id"
            AND contact."id" = link."canonical_id"
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'IDENTITY_LINK_CONTRACT_PREFLIGHT_TARGET_INVALID';
  END IF;
END
$identity_link_contract_preflight$;

ALTER TABLE "organization_identity_conflict"
  ADD CONSTRAINT "organization_identity_conflict_resolved_time_check" CHECK (
    "resolved_at" IS NULL OR "resolved_at" >= "created_at"
  );

ALTER TABLE "organization_identifier"
  ADD CONSTRAINT "organization_identifier_seen_time_check" CHECK (
    "last_seen_at" >= "first_seen_at"
  ),
  ADD CONSTRAINT "organization_identifier_revoked_time_check" CHECK (
    "revoked_at" IS NULL OR "revoked_at" >= "last_seen_at"
  );

ALTER TABLE "organization_canonical_mapping"
  ADD CONSTRAINT "organization_canonical_mapping_revoked_time_check" CHECK (
    "revoked_at" IS NULL OR "revoked_at" >= "created_at"
  );

ALTER TABLE "organization_identity_replay"
  ADD CONSTRAINT "organization_identity_replay_state_shape_check" CHECK (
    (
      "status" = 'PENDING'
      AND "attempt" = 0
      AND "output_hash" IS NULL
      AND "error_code" IS NULL
      AND "completed_at" IS NULL
    )
    OR (
      "status" = 'RUNNING'
      AND "attempt" > 0
      AND "output_hash" IS NULL
      AND "error_code" IS NULL
      AND "completed_at" IS NULL
    )
    OR (
      "status" = 'SUCCEEDED'
      AND "attempt" > 0
      AND "output_hash" IS NOT NULL
      AND "error_code" IS NULL
      AND "completed_at" IS NOT NULL
    )
    OR (
      "status" = 'FAILED'
      AND "attempt" > 0
      AND "output_hash" IS NULL
      AND "error_code" IS NOT NULL
      AND length(btrim("error_code")) > 0
      AND "completed_at" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "organization_identity_replay_time_check" CHECK (
    "updated_at" >= "created_at"
    AND (
      "completed_at" IS NULL
      OR (
        "completed_at" >= "created_at"
        AND "completed_at" <= "updated_at"
      )
    )
  );

ALTER TABLE "identity_link"
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE',
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "resolver_version" SET DEFAULT 'identity-v1',
  ALTER COLUMN "resolver_version" SET NOT NULL,
  ALTER COLUMN "input_hash" SET DEFAULT 'legacy',
  ALTER COLUMN "input_hash" SET NOT NULL,
  ADD CONSTRAINT "identity_link_input_hash_check" CHECK (
    "input_hash" = 'legacy' OR "input_hash" ~ '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX "identity_link_workspace_canonical_raw_key"
  ON "identity_link"(
    "workspace_id", "canonical_type", "canonical_id", "raw_record_id"
  );

CREATE FUNCTION enforce_identity_link_target_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $enforce_identity_link_target_v2$
BEGIN
  IF NEW."canonical_type" = 'company' THEN
    PERFORM 1
    FROM public."canonical_company" AS company
    WHERE company."workspace_id" = NEW."workspace_id"
      AND company."id" = NEW."canonical_id"
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'IDENTITY_LINK_CANONICAL_TARGET_INVALID';
    END IF;
  ELSIF NEW."canonical_type" = 'contact' THEN
    PERFORM 1
    FROM public."canonical_contact" AS contact
    WHERE contact."workspace_id" = NEW."workspace_id"
      AND contact."id" = NEW."canonical_id"
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'IDENTITY_LINK_CANONICAL_TARGET_INVALID';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'IDENTITY_LINK_CANONICAL_TYPE_INVALID';
  END IF;

  RETURN NEW;
END
$enforce_identity_link_target_v2$;

CREATE FUNCTION enforce_identity_link_contract_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $enforce_identity_link_contract_v2$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'IDENTITY_LINK_DELETE_FORBIDDEN';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."canonical_type" IS DISTINCT FROM OLD."canonical_type"
    OR NEW."canonical_id" IS DISTINCT FROM OLD."canonical_id"
    OR NEW."raw_record_id" IS DISTINCT FROM OLD."raw_record_id"
    OR NEW."match_rule" IS DISTINCT FROM OLD."match_rule"
    OR NEW."confidence" IS DISTINCT FROM OLD."confidence"
    OR NEW."resolver_version" IS DISTINCT FROM OLD."resolver_version"
    OR NEW."input_hash" IS DISTINCT FROM OLD."input_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."conflict_id" IS DISTINCT FROM OLD."conflict_id"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'IDENTITY_LINK_IMMUTABLE';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  IF (
    OLD."status" = 'PENDING_CONFLICT'
    AND NEW."status" IN ('ACTIVE', 'REVOKED')
  ) OR (
    OLD."status" = 'ACTIVE'
    AND NEW."status" = 'REVOKED'
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'IDENTITY_LINK_STATUS_TRANSITION_INVALID';
END
$enforce_identity_link_contract_v2$;

CREATE FUNCTION enforce_organization_identifier_contract_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $enforce_organization_identifier_contract_v2$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTIFIER_DELETE_FORBIDDEN';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."company_id" IS DISTINCT FROM OLD."company_id"
    OR NEW."scheme" IS DISTINCT FROM OLD."scheme"
    OR NEW."jurisdiction" IS DISTINCT FROM OLD."jurisdiction"
    OR NEW."normalized_value" IS DISTINCT FROM OLD."normalized_value"
    OR NEW."authority_provider_key" IS DISTINCT FROM OLD."authority_provider_key"
    OR NEW."raw_record_id" IS DISTINCT FROM OLD."raw_record_id"
    OR NEW."conflict_id" IS DISTINCT FROM OLD."conflict_id"
    OR NEW."confidence" IS DISTINCT FROM OLD."confidence"
    OR NEW."normalizer_version" IS DISTINCT FROM OLD."normalizer_version"
    OR NEW."validator_version" IS DISTINCT FROM OLD."validator_version"
    OR NEW."provenance" IS DISTINCT FROM OLD."provenance"
    OR NEW."first_seen_at" IS DISTINCT FROM OLD."first_seen_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTIFIER_IMMUTABLE';
  END IF;

  IF NEW."last_seen_at" < OLD."last_seen_at"
    OR NEW."last_seen_at" < NEW."first_seen_at"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTIFIER_LAST_SEEN_REGRESSION';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTIFIER_STATUS_TRANSITION_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PENDING_CONFLICT'
    AND NEW."status" = 'ACTIVE'
    AND NEW."revoked_at" IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('PENDING_CONFLICT', 'ACTIVE')
    AND NEW."status" = 'REVOKED'
    AND NEW."revoked_at" IS NOT NULL
    AND NEW."revoked_at" >= NEW."last_seen_at"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'ORGANIZATION_IDENTIFIER_STATUS_TRANSITION_INVALID';
END
$enforce_organization_identifier_contract_v2$;

CREATE FUNCTION enforce_organization_identity_conflict_contract_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $enforce_organization_identity_conflict_contract_v2$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_CONFLICT_DELETE_FORBIDDEN';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."raw_record_id" IS DISTINCT FROM OLD."raw_record_id"
    OR NEW."conflict_type" IS DISTINCT FROM OLD."conflict_type"
    OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
    OR NEW."facts" IS DISTINCT FROM OLD."facts"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_CONFLICT_IMMUTABLE';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."revision" IS DISTINCT FROM OLD."revision" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_CONFLICT_REVISION_INVALID';
    END IF;
    IF NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_CONFLICT_STATUS_TRANSITION_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_CONFLICT_REVISION_INVALID';
  END IF;

  IF OLD."status" = 'OPEN'
    AND NEW."status" = 'RESOLVING'
    AND NEW."resolved_at" IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RESOLVING'
    AND NEW."status" = 'RESOLVED'
    AND NEW."resolved_at" IS NOT NULL
    AND NEW."resolved_at" >= NEW."created_at"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'ORGANIZATION_IDENTITY_CONFLICT_STATUS_TRANSITION_INVALID';
END
$enforce_organization_identity_conflict_contract_v2$;

CREATE FUNCTION enforce_organization_identity_conflict_party_contract_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $enforce_organization_identity_conflict_party_contract_v2$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_CONFLICT_PARTY_DELETE_FORBIDDEN';
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'ORGANIZATION_IDENTITY_CONFLICT_PARTY_IMMUTABLE';
END
$enforce_organization_identity_conflict_party_contract_v2$;

CREATE FUNCTION enforce_organization_identity_decision_contract_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $enforce_organization_identity_decision_contract_v2$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_DECISION_DELETE_FORBIDDEN';
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'ORGANIZATION_IDENTITY_DECISION_APPEND_ONLY';
END
$enforce_organization_identity_decision_contract_v2$;

CREATE FUNCTION enforce_organization_canonical_mapping_contract_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $enforce_organization_canonical_mapping_contract_v2$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_DELETE_FORBIDDEN';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."organization_identity_decision" AS decision
    WHERE decision."id" = NEW."merge_decision_id"
      AND decision."workspace_id" = NEW."workspace_id"
      AND decision."action" = 'MERGE'
      AND decision."canonical_company_id" = NEW."canonical_company_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID';
  END IF;

  IF NEW."split_decision_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public."organization_identity_decision" AS decision
      WHERE decision."id" = NEW."split_decision_id"
        AND decision."workspace_id" = NEW."workspace_id"
        AND decision."action" = 'SPLIT'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE'
      OR NEW."revision" <> 1
      OR NEW."split_decision_id" IS NOT NULL
      OR NEW."revoked_at" IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_STATUS_TRANSITION_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."source_company_id" IS DISTINCT FROM OLD."source_company_id"
    OR NEW."canonical_company_id" IS DISTINCT FROM OLD."canonical_company_id"
    OR NEW."merge_decision_id" IS DISTINCT FROM OLD."merge_decision_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_IMMUTABLE';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."revision" IS DISTINCT FROM OLD."revision" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_REVISION_INVALID';
    END IF;
    IF NEW."split_decision_id" IS DISTINCT FROM OLD."split_decision_id"
      OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_STATUS_TRANSITION_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_REVISION_INVALID';
  END IF;

  IF OLD."status" = 'ACTIVE'
    AND NEW."status" = 'REVOKED'
    AND NEW."split_decision_id" IS NOT NULL
    AND NEW."revoked_at" IS NOT NULL
    AND NEW."revoked_at" >= NEW."created_at"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'ORGANIZATION_CANONICAL_MAPPING_STATUS_TRANSITION_INVALID';
END
$enforce_organization_canonical_mapping_contract_v2$;

CREATE FUNCTION enforce_organization_identity_replay_contract_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $enforce_organization_identity_replay_contract_v2$
DECLARE
  referenced_hash VARCHAR(64);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_DELETE_FORBIDDEN';
  END IF;

  SELECT decision."decision_hash"
  INTO referenced_hash
  FROM public."organization_identity_decision" AS decision
  WHERE decision."workspace_id" = NEW."workspace_id"
    AND decision."id" = NEW."decision_id";

  IF referenced_hash IS NULL OR NEW."input_hash" IS DISTINCT FROM referenced_hash THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_INPUT_HASH_MISMATCH';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."updated_at" < NEW."created_at" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_TIMESTAMP_INVALID';
    END IF;
    IF NEW."status" <> 'PENDING'
      OR NEW."attempt" <> 0
      OR NEW."output_hash" IS NOT NULL
      OR NEW."error_code" IS NOT NULL
      OR NEW."completed_at" IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."decision_id" IS DISTINCT FROM OLD."decision_id"
    OR NEW."input_hash" IS DISTINCT FROM OLD."input_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_IMMUTABLE';
  END IF;

  IF NEW."updated_at" < OLD."updated_at"
    OR NEW."updated_at" < NEW."created_at"
    OR (
      NEW."completed_at" IS NOT NULL
      AND (
        NEW."completed_at" < NEW."created_at"
        OR NEW."completed_at" > NEW."updated_at"
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_TIMESTAMP_INVALID';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."attempt" IS DISTINCT FROM OLD."attempt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_ATTEMPT_INVALID';
    END IF;
    IF NEW."output_hash" IS DISTINCT FROM OLD."output_hash"
      OR NEW."error_code" IS DISTINCT FROM OLD."error_code"
      OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('PENDING', 'FAILED') AND NEW."status" = 'RUNNING' THEN
    IF NEW."attempt" <> OLD."attempt" + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_ATTEMPT_INVALID';
    END IF;
    IF NEW."output_hash" IS NOT NULL
      OR NEW."error_code" IS NOT NULL
      OR NEW."completed_at" IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RUNNING' AND NEW."status" IN ('SUCCEEDED', 'FAILED') THEN
    IF NEW."attempt" <> OLD."attempt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_ATTEMPT_INVALID';
    END IF;
    IF NEW."completed_at" IS NULL
      OR (
        NEW."status" = 'SUCCEEDED'
        AND (NEW."output_hash" IS NULL OR NEW."error_code" IS NOT NULL)
      )
      OR (
        NEW."status" = 'FAILED'
        AND (
          NEW."output_hash" IS NOT NULL
          OR NEW."error_code" IS NULL
          OR length(btrim(NEW."error_code")) = 0
        )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID';
END
$enforce_organization_identity_replay_contract_v2$;

CREATE TRIGGER "identity_link_10_typed_target_guard"
BEFORE INSERT OR UPDATE OF "workspace_id", "canonical_type", "canonical_id"
ON "identity_link"
FOR EACH ROW
EXECUTE FUNCTION enforce_identity_link_target_v2();

CREATE TRIGGER "identity_link_20_contract_guard"
BEFORE UPDATE OR DELETE ON "identity_link"
FOR EACH ROW
EXECUTE FUNCTION enforce_identity_link_contract_v2();

CREATE TRIGGER "organization_identifier_contract_guard"
BEFORE UPDATE OR DELETE ON "organization_identifier"
FOR EACH ROW
EXECUTE FUNCTION enforce_organization_identifier_contract_v2();

CREATE TRIGGER "organization_identity_conflict_contract_guard"
BEFORE UPDATE OR DELETE ON "organization_identity_conflict"
FOR EACH ROW
EXECUTE FUNCTION enforce_organization_identity_conflict_contract_v2();

CREATE TRIGGER "organization_identity_conflict_party_contract_guard"
BEFORE UPDATE OR DELETE ON "organization_identity_conflict_party"
FOR EACH ROW
EXECUTE FUNCTION enforce_organization_identity_conflict_party_contract_v2();

CREATE TRIGGER "organization_identity_decision_contract_guard"
BEFORE UPDATE OR DELETE ON "organization_identity_decision"
FOR EACH ROW
EXECUTE FUNCTION enforce_organization_identity_decision_contract_v2();

CREATE TRIGGER "organization_canonical_mapping_contract_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "organization_canonical_mapping"
FOR EACH ROW
EXECUTE FUNCTION enforce_organization_canonical_mapping_contract_v2();

CREATE TRIGGER "organization_identity_replay_contract_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "organization_identity_replay"
FOR EACH ROW
EXECUTE FUNCTION enforce_organization_identity_replay_contract_v2();

REVOKE ALL ON FUNCTION enforce_identity_link_target_v2() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION enforce_identity_link_contract_v2() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION enforce_organization_identifier_contract_v2() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION enforce_organization_identity_conflict_contract_v2() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION enforce_organization_identity_conflict_party_contract_v2() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION enforce_organization_identity_decision_contract_v2() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION enforce_organization_canonical_mapping_contract_v2() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION enforce_organization_identity_replay_contract_v2() FROM PUBLIC, app_user;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "organization_identifier" FROM app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "organization_identity_conflict" FROM app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "organization_identity_conflict_party" FROM app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "organization_identity_decision" FROM app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "organization_canonical_mapping" FROM app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "organization_identity_replay" FROM app_user;

COMMIT;
