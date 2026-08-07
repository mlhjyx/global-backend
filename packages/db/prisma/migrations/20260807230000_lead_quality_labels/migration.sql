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
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lead_quality_label"
  ADD CONSTRAINT "lead_quality_label_event_scope_fkey"
  FOREIGN KEY ("lead_qualified_event_id", "workspace_id")
  REFERENCES "outbox_event"("event_id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

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
