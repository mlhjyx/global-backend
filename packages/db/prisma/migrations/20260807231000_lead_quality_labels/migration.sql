-- Append-only quality-label return seam. This records downstream facts only;
-- it intentionally creates no Opportunity/QGO aggregate and never changes lead.status.

CREATE TYPE "lead_quality_label_type" AS ENUM (
  'QGO_CREATED',
  'SALES_ACCEPTED',
  'COMMERCIAL_OUTCOME_VERIFIED',
  'LEAD_OUTCOME_REJECTED'
);

CREATE TYPE "lead_quality_reason_code" AS ENUM (
  'NOT_ICP',
  'BAD_TIMING',
  'UNREACHABLE',
  'DUPLICATE',
  'INSUFFICIENT_EVIDENCE',
  'COMPLIANCE_BLOCKED',
  'OTHER'
);

CREATE TYPE "lead_quality_commercial_result" AS ENUM ('WON', 'LOST');
CREATE TYPE "lead_quality_label_disposition" AS ENUM ('ACCEPTED', 'HELD');
CREATE TYPE "lead_quality_label_held_reason" AS ENUM (
  'OCCURRED_BEFORE_HANDOFF',
  'OCCURRED_AT_IN_FUTURE',
  'OUT_OF_ORDER_ARRIVAL',
  'MISSING_QGO_CREATED',
  'MISSING_PREREQUISITE',
  'CONTRADICTORY_POSITIVE_LABEL',
  'CONTRADICTORY_REJECTION',
  'CONTRADICTORY_COMMERCIAL_RESULT'
);

-- Composite tenant keys make it impossible for a label row to bind a known
-- UUID from a different workspace, even if an application check regresses.
CREATE UNIQUE INDEX "lead_id_workspace_id_key" ON "lead"("id", "workspace_id");
CREATE UNIQUE INDEX "outbox_event_event_id_workspace_id_key" ON "outbox_event"("event_id", "workspace_id");

CREATE TABLE "lead_quality_label" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "source_event_id" VARCHAR(128) NOT NULL,
  "lead_id" UUID NOT NULL,
  "lead_qualified_event_id" UUID NOT NULL,
  "label" "lead_quality_label_type" NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "source_system" VARCHAR(64) NOT NULL,
  "external_object_ref" VARCHAR(256),
  "reason_code" "lead_quality_reason_code",
  "commercial_result" "lead_quality_commercial_result",
  "disposition" "lead_quality_label_disposition" NOT NULL,
  "held_reason" "lead_quality_label_held_reason",
  "actor_id" VARCHAR(255) NOT NULL,
  "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lead_quality_label_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_quality_label_source_event_visible_check" CHECK (
    char_length("source_event_id") BETWEEN 1 AND 128
    AND "source_event_id" ~ '^[!-~]+$'
  ),
  CONSTRAINT "lead_quality_label_source_system_check" CHECK (
    "source_system" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT "lead_quality_label_external_ref_visible_check" CHECK (
    "external_object_ref" IS NULL OR (
      char_length("external_object_ref") BETWEEN 1 AND 256
      AND "external_object_ref" ~ '^[!-~]+$'
    )
  ),
  CONSTRAINT "lead_quality_label_semantic_fields_check" CHECK (
    (
      "label" = 'LEAD_OUTCOME_REJECTED'
      AND "reason_code" IS NOT NULL
      AND "commercial_result" IS NULL
    ) OR (
      "label" = 'COMMERCIAL_OUTCOME_VERIFIED'
      AND "reason_code" IS NULL
      AND "commercial_result" IS NOT NULL
    ) OR (
      "label" IN ('QGO_CREATED', 'SALES_ACCEPTED')
      AND "reason_code" IS NULL
      AND "commercial_result" IS NULL
    )
  ),
  CONSTRAINT "lead_quality_label_disposition_check" CHECK (
    ("disposition" = 'ACCEPTED' AND "held_reason" IS NULL)
    OR ("disposition" = 'HELD' AND "held_reason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "lead_quality_label_source_event_key"
  ON "lead_quality_label"("workspace_id", "source_system", "source_event_id");
CREATE INDEX "lead_quality_label_learning_idx"
  ON "lead_quality_label"("workspace_id", "lead_id", "disposition", "occurred_at");
CREATE INDEX "lead_quality_label_event_idx"
  ON "lead_quality_label"("workspace_id", "lead_qualified_event_id");

ALTER TABLE "lead_quality_label"
  ADD CONSTRAINT "lead_quality_label_lead_scope_fkey"
  FOREIGN KEY ("lead_id", "workspace_id")
  REFERENCES "lead"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "lead_quality_label"
  ADD CONSTRAINT "lead_quality_label_event_scope_fkey"
  FOREIGN KEY ("lead_qualified_event_id", "workspace_id")
  REFERENCES "outbox_event"("event_id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- The two-column FK proves tenant provenance but cannot encode event type and
-- aggregate identity. This owner-defined trigger closes that gap even for a
-- direct app_user INSERT; its fixed search_path and qualified relation prevent
-- object-shadowing attacks.
CREATE FUNCTION "enforce_lead_quality_label_handoff_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_workspace text := current_setting('app.current_workspace_id', true);
  handoff_matches boolean;
BEGIN
  -- SECURITY DEFINER does not bypass FORCE RLS when the function owner lacks
  -- BYPASSRLS. Scope the lookup to the row's tenant, then restore the caller's
  -- transaction-local setting before returning or raising.
  PERFORM set_config('app.current_workspace_id', NEW."workspace_id"::text, true);
  SELECT EXISTS (
    SELECT 1
    FROM public."outbox_event"
    WHERE "event_id" = NEW."lead_qualified_event_id"
      AND "workspace_id" = NEW."workspace_id"
      AND "event_type" = 'LeadQualified'
      AND "aggregate_type" = 'Lead'
      AND "aggregate_id" = NEW."lead_id"::text
  ) INTO handoff_matches;
  PERFORM set_config('app.current_workspace_id', COALESCE(previous_workspace, ''), true);

  IF NOT handoff_matches THEN
    RAISE EXCEPTION 'lead quality label must bind the exact LeadQualified handoff'
      USING ERRCODE = '23503',
            CONSTRAINT = 'lead_quality_label_handoff_identity_fkey';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "enforce_lead_quality_label_handoff_identity"() FROM PUBLIC;
CREATE TRIGGER "enforce_lead_quality_label_handoff_identity"
BEFORE INSERT ON "lead_quality_label"
FOR EACH ROW EXECUTE FUNCTION "enforce_lead_quality_label_handoff_identity"();

-- Preserve provenance after insertion. The ordinary FK already blocks event
-- id/workspace updates; this companion trigger blocks later type/aggregate
-- mutation by an owner or maintenance path while any label references it.
CREATE FUNCTION "protect_lead_quality_label_handoff_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_workspace text := current_setting('app.current_workspace_id', true);
  referenced_label_exists boolean;
BEGIN
  PERFORM set_config('app.current_workspace_id', OLD."workspace_id"::text, true);
  SELECT EXISTS (
    SELECT 1
    FROM public."lead_quality_label"
    WHERE "lead_qualified_event_id" = OLD."event_id"
      AND "workspace_id" = OLD."workspace_id"
  ) INTO referenced_label_exists;
  PERFORM set_config('app.current_workspace_id', COALESCE(previous_workspace, ''), true);

  IF referenced_label_exists THEN
    RAISE EXCEPTION 'referenced LeadQualified handoff identity is immutable'
      USING ERRCODE = '23503',
            CONSTRAINT = 'lead_quality_label_handoff_identity_fkey';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "protect_lead_quality_label_handoff_identity"() FROM PUBLIC;
CREATE TRIGGER "protect_lead_quality_label_handoff_identity"
BEFORE UPDATE OF "event_type", "aggregate_type", "aggregate_id" ON "outbox_event"
FOR EACH ROW
WHEN (
  OLD."event_type" IS DISTINCT FROM NEW."event_type"
  OR OLD."aggregate_type" IS DISTINCT FROM NEW."aggregate_type"
  OR OLD."aggregate_id" IS DISTINCT FROM NEW."aggregate_id"
)
EXECUTE FUNCTION "protect_lead_quality_label_handoff_identity"();

ALTER TABLE "lead_quality_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_quality_label" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_quality_label_tenant_isolation" ON "lead_quality_label"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- app_user may append and read facts, but cannot rewrite, remove, truncate,
-- attach triggers, or acquire REFERENCES privilege to bypass the seam.
REVOKE ALL ON TABLE "lead_quality_label" FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE "lead_quality_label" TO app_user;
REVOKE UPDATE, DELETE ON TABLE "lead_quality_label" FROM app_user;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "lead_quality_label" FROM app_user;
