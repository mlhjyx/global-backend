-- Ordinary application sessions may add suppression facts and request review,
-- but may never update/delete a suppression or release it directly.

CREATE UNIQUE INDEX "suppression_record_id_workspace_key"
  ON "suppression_record"("id", "workspace_id");

CREATE TABLE "suppression_release_decision" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "suppression_record_id" UUID NOT NULL,
  "request_kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "justification" TEXT NOT NULL,
  "evidence_ref" TEXT,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "suppression_release_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "suppression_release_decision_kind_check"
    CHECK ("request_kind" IN ('USER_PREFERENCE', 'IDENTITY_CORRECTION')),
  CONSTRAINT "suppression_release_decision_status_check"
    CHECK ("status" IN ('PENDING_REVIEW', 'PENDING_LEGAL_REVIEW')),
  CONSTRAINT "suppression_release_decision_justification_check"
    CHECK (
      char_length("justification") BETWEEN 1 AND 500
      AND "justification" !~ '[[:cntrl:]]'
    ),
  CONSTRAINT "suppression_release_decision_evidence_ref_check"
    CHECK (
      "evidence_ref" IS NULL
      OR "evidence_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    ),
  CONSTRAINT "suppression_release_decision_correction_evidence_check"
    CHECK (
      "request_kind" <> 'IDENTITY_CORRECTION'
      OR "evidence_ref" IS NOT NULL
    ),
  CONSTRAINT "suppression_release_decision_record_scope_fkey"
    FOREIGN KEY ("suppression_record_id", "workspace_id")
    REFERENCES "suppression_record"("id", "workspace_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "suppression_release_decision_record_idx"
  ON "suppression_release_decision"(
    "workspace_id", "suppression_record_id", "created_at"
  );

ALTER TABLE "suppression_release_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppression_release_decision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "suppression_release_decision_tenant_isolation"
  ON "suppression_release_decision"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE UPDATE, DELETE ON TABLE "suppression_record" FROM app_user;
REVOKE ALL ON TABLE "suppression_release_decision" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "suppression_release_decision" FROM app_user;
GRANT SELECT, INSERT ON TABLE "suppression_release_decision" TO app_user;
