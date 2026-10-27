-- BI-20 / BI-23 delivery loop (design owner-approved 2026-10-10, L2):
--   * lead_decision.reason_code: the stable reject / outcome reason enum next to the
--     free-text note. Nullable so historical decisions stay valid; the API requires it
--     on reject (422 REASON_CODE_REQUIRED).
--   * lead_outcome: append-only customer/operator feedback on a delivered lead. One row
--     per submission; a changed judgement is a new row. Composite foreign key
--     (workspace_id, lead_id) keeps it on a lead of the same workspace and deletes it
--     with the lead; the tenant key needs the new unique index on lead(workspace_id, id).
--     No column holds an email address, phone number or person name.
--   * RLS: ENABLE + FORCE + the tenant policy of the discovery tables. app_user gets
--     SELECT and INSERT only (append-only); docs/governance/app-user-table-privileges.json
--     lists the same two.
--
-- Additive, no backfill. Deploy in name order, in the same window as the image that
-- carries this migration. Rollback: a later migration that drops lead_outcome, drops
-- the two lead_decision changes and the lead unique index (nothing else references them).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "lead_decision" ADD COLUMN "reason_code" VARCHAR(64);

ALTER TABLE "lead_decision" ADD CONSTRAINT "lead_decision_reason_code_check" CHECK ("reason_code" IS NULL OR "reason_code" IN (
    'NOT_TARGET_ROLE', 'WRONG_PRODUCT', 'TOO_SMALL', 'TOO_LARGE', 'ALREADY_KNOWN',
    'NO_IMPORT_SIGNAL', 'WRONG_COUNTRY', 'BAD_CONTACT_PATH', 'DUPLICATE', 'OTHER',
    'GOOD_FIT', 'WILL_FOLLOW_UP'
  ));

CREATE UNIQUE INDEX "lead_workspace_id_id_key" ON "lead"("workspace_id", "id");

CREATE TABLE "lead_outcome" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "relevance" INTEGER,
  "willing_to_contact" BOOLEAN,
  "reason_code" VARCHAR(64),
  "note" TEXT,
  "contacted" BOOLEAN,
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lead_outcome_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_outcome_relevance_check" CHECK ("relevance" IS NULL OR ("relevance" BETWEEN 1 AND 5)),
  CONSTRAINT "lead_outcome_source_check" CHECK ("source" IN ('customer', 'operator')),
  CONSTRAINT "lead_outcome_note_check" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 2000),
  CONSTRAINT "lead_outcome_reason_code_check" CHECK (
    "reason_code" IS NULL OR "reason_code" IN (
      'NOT_TARGET_ROLE', 'WRONG_PRODUCT', 'TOO_SMALL', 'TOO_LARGE', 'ALREADY_KNOWN',
      'NO_IMPORT_SIGNAL', 'WRONG_COUNTRY', 'BAD_CONTACT_PATH', 'DUPLICATE', 'OTHER',
      'GOOD_FIT', 'WILL_FOLLOW_UP'
    )
  ),
  CONSTRAINT "lead_outcome_lead_fkey" FOREIGN KEY ("workspace_id", "lead_id")
    REFERENCES "lead"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "lead_outcome_workspace_id_lead_id_idx"
  ON "lead_outcome"("workspace_id", "lead_id");

ALTER TABLE "lead_outcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_outcome" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_outcome_tenant_isolation" ON "lead_outcome"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT ON TABLE "lead_outcome" TO app_user;

COMMIT;
