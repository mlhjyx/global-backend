-- Suppression facts remain present even when an operator requests a release or identity correction.
-- Existing null/manual/bounce records are preference-class; every unknown or legal-shaped reason fails closed as LEGAL.
ALTER TABLE "suppression_record"
  ADD COLUMN "protection_class" TEXT NOT NULL DEFAULT 'LEGAL';

UPDATE "suppression_record"
SET "protection_class" = 'PREFERENCE'
WHERE "reason" IS NULL OR "reason" IN ('manual', 'bounce');

ALTER TABLE "suppression_record"
  ADD CONSTRAINT "suppression_record_protection_class_check"
  CHECK ("protection_class" IN ('PREFERENCE', 'LEGAL')),
  ADD CONSTRAINT "suppression_record_preference_reason_check"
  CHECK (
    "protection_class" <> 'PREFERENCE'
    OR "reason" IS NULL
    OR lower("reason") IN ('manual', 'bounce')
  );

CREATE UNIQUE INDEX "suppression_record_workspace_id_id_key"
  ON "suppression_record"("workspace_id", "id");

CREATE TABLE "suppression_decision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "suppression_id" UUID NOT NULL,
  "request_id" VARCHAR(128) NOT NULL,
  "decision" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "actor_id" VARCHAR(256) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "suppression_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "suppression_decision_decision_check" CHECK (
    "decision" IN ('RELEASE_REQUESTED', 'RELEASE_REQUEST_DENIED', 'IDENTITY_CORRECTION_REQUESTED')
  ),
  CONSTRAINT "suppression_decision_reason_code_check" CHECK (
    "reason_code" IN (
      'USER_PREFERENCE_CHANGED',
      'BOUNCE_CLASSIFICATION_ERROR',
      'IDENTITY_MISASSOCIATION',
      'DUPLICATE_RECORD',
      'LEGAL_SUPPRESSION_IMMUTABLE',
      'OTHER'
    )
  ),
  CONSTRAINT "suppression_decision_semantic_pair_check" CHECK (
    (
      "decision" = 'RELEASE_REQUESTED'
      AND "reason_code" IN ('USER_PREFERENCE_CHANGED', 'BOUNCE_CLASSIFICATION_ERROR', 'OTHER')
    )
    OR (
      "decision" = 'IDENTITY_CORRECTION_REQUESTED'
      AND "reason_code" IN ('IDENTITY_MISASSOCIATION', 'DUPLICATE_RECORD', 'OTHER')
    )
    OR (
      "decision" = 'RELEASE_REQUEST_DENIED'
      AND "reason_code" = 'LEGAL_SUPPRESSION_IMMUTABLE'
    )
  ),
  CONSTRAINT "suppression_decision_workspace_record_fkey"
    FOREIGN KEY ("workspace_id", "suppression_id")
    REFERENCES "suppression_record"("workspace_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "suppression_decision_workspace_id_request_id_key"
  ON "suppression_decision"("workspace_id", "request_id");
CREATE INDEX "suppression_decision_workspace_id_suppression_id_created_at_idx"
  ON "suppression_decision"("workspace_id", "suppression_id", "created_at");

ALTER TABLE "suppression_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppression_decision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "suppression_decision_tenant_isolation" ON "suppression_decision"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT ON TABLE "suppression_decision" TO app_user;
REVOKE UPDATE, DELETE ON TABLE "suppression_decision" FROM app_user;

-- The compatibility DELETE endpoint no longer deletes. DB privilege is the final backstop against regressions.
REVOKE DELETE ON TABLE "suppression_record" FROM app_user;

-- Existing records are immutable except for a one-way PREFERENCE -> LEGAL protection promotion.
CREATE OR REPLACE FUNCTION enforce_suppression_record_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."value" IS DISTINCT FROM OLD."value"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'suppression facts are immutable';
  END IF;

  IF OLD."protection_class" = 'LEGAL' AND NEW."protection_class" <> 'LEGAL' THEN
    RAISE EXCEPTION 'legal suppression cannot be downgraded';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "suppression_record_immutable_guard"
BEFORE UPDATE ON "suppression_record"
FOR EACH ROW EXECUTE FUNCTION enforce_suppression_record_immutable();
