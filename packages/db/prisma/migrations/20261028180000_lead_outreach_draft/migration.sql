-- BI-15 / L5 outreach first-contact draft (design owner-approved 2026-10-10, §7):
--   * lead_outreach_draft: append-only first-contact draft of a delivered lead, one row
--     per version (version starts at 1 and grows within the lead). The weekly report reads
--     the newest version. The platform never sends it; the body ends with the seller's own
--     reply entry (website / email / wa.me link) appended by code, not by the model.
--   * Composite foreign key (workspace_id, lead_id) keeps each draft on a lead of the same
--     workspace and deletes it with the lead (DSR erasure of the company reaches the lead).
--     Nothing updates or deletes a draft on its own.
--   * The table holds company-level facts only (used_facts are keys of those facts); the
--     prompt carries no personal name, email or phone of the buyer.
--   * RLS: ENABLE + FORCE + the tenant policy of the other workspace tables. app_user gets
--     SELECT and INSERT only (append-only); docs/governance/app-user-table-privileges.json
--     lists the same two.
--
-- Additive, no backfill. Deploy in name order, in the same window as the image that
-- carries this migration. Rollback: a later migration that drops lead_outreach_draft
-- (nothing else references it).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "lead_outreach_draft" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "language" VARCHAR(16) NOT NULL,
  "subject" VARCHAR(200) NOT NULL,
  "body" TEXT NOT NULL,
  "body_zh" TEXT NOT NULL,
  "used_facts" JSONB NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lead_outreach_draft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_outreach_draft_version_check" CHECK ("version" BETWEEN 1 AND 1000000),
  CONSTRAINT "lead_outreach_draft_language_check" CHECK ("language" ~ '^[a-z]{2,3}$'),
  CONSTRAINT "lead_outreach_draft_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 200),
  CONSTRAINT "lead_outreach_draft_body_check" CHECK (char_length("body") BETWEEN 1 AND 4000),
  CONSTRAINT "lead_outreach_draft_body_zh_check" CHECK (char_length("body_zh") BETWEEN 1 AND 4000),
  CONSTRAINT "lead_outreach_draft_used_facts_check" CHECK (
    jsonb_typeof("used_facts") = 'array' AND jsonb_array_length("used_facts") BETWEEN 1 AND 40
  ),
  CONSTRAINT "lead_outreach_draft_model_check" CHECK (char_length("model") BETWEEN 1 AND 120),
  CONSTRAINT "lead_outreach_draft_lead_fkey" FOREIGN KEY ("workspace_id", "lead_id")
    REFERENCES "lead"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "lead_outreach_draft_workspace_id_lead_id_version_key"
  ON "lead_outreach_draft"("workspace_id", "lead_id", "version");

CREATE INDEX "lead_outreach_draft_lead_id_version_idx"
  ON "lead_outreach_draft"("lead_id", "version");

ALTER TABLE "lead_outreach_draft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_outreach_draft" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_outreach_draft_tenant_isolation" ON "lead_outreach_draft"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT ON TABLE "lead_outreach_draft" TO app_user;

COMMIT;
