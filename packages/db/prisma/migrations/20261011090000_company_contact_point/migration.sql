-- BI-14 company contact paths (design owner-approved 2026-10-10, revised the same day: links
-- only). One tenant table for links to a company's own contact paths, read from the homepage
-- the website profile already fetches: its contact, Impressum and supplier pages on the
-- company's domain, its LinkedIn company page and X account, and its contact page when that
-- page carries a contact form.
--
-- Links only. No column holds an email address, a phone number or a name, and the CHECK
-- constraints admit green data only, the six kinds, https URLs without query, fragment, '@'
-- or whitespace, and the exact company-page patterns for the LinkedIn and X kinds. The
-- automatic path (provider company_contact) writes UNVERIFIED only; VALID and OPERATOR_REJECTED
-- need updated_by, that is a person. The composite foreign key keeps a point on a company of
-- the same workspace and removes it with the company; DSR erasure of a company deletes its
-- points explicitly. RLS: ENABLE + FORCE + the tenant policy of the discovery tables. app_user
-- gets SELECT, INSERT, UPDATE and DELETE (the writer, the REMOVED_FROM_SITE update and DSR
-- erasure): since 20261010090000 a new table starts SELECT-only for it, and
-- docs/governance/app-user-table-privileges.json lists the same four.
--
-- Additive, no backfill; the switch data_provider.company_contact is seeded DISABLED, so no row
-- is written until it is turned on. Deploy in name order, in the same window as the image that
-- carries this migration. Rollback: a later migration that drops the table (nothing else
-- references it).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "company_contact_point" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "status_reason" TEXT,
  "data_class" TEXT NOT NULL DEFAULT 'green',
  "source_kind" TEXT NOT NULL,
  "provider_key" TEXT NOT NULL,
  "parser_version" TEXT NOT NULL,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "updated_by" TEXT,

  CONSTRAINT "company_contact_point_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_contact_point_kind_check" CHECK ("kind" IN ('contact_page', 'impressum_page', 'contact_form', 'supplier_page', 'linkedin_company_page', 'x_company_account')),
  CONSTRAINT "company_contact_point_value_check" CHECK (
    char_length("value") BETWEEN 10 AND 2048
    AND "value" LIKE 'https://%'
    AND strpos("value", '?') = 0
    AND strpos("value", '#') = 0
    AND strpos("value", '@') = 0
    AND "value" !~ '[[:space:]]'
  ),
  CONSTRAINT "company_contact_point_social_value_check" CHECK (
    CASE "kind"
      WHEN 'linkedin_company_page' THEN "value" ~ '^https://www\.linkedin\.com/(company|showcase)/[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'
      WHEN 'x_company_account' THEN "value" ~ '^https://x\.com/[a-z0-9_]{1,15}$'
      ELSE TRUE
    END
  ),
  -- Every branch tests status_reason IS NOT NULL first: a NULL comparison would make the whole
  -- OR NULL, and a CHECK that evaluates to NULL passes.
  CONSTRAINT "company_contact_point_status_check" CHECK (
    ("status" = 'UNVERIFIED' AND "status_reason" IS NULL)
    OR ("status" = 'VALID' AND "status_reason" IS NOT NULL AND "status_reason" = 'OPERATOR_CONFIRMED' AND "updated_by" IS NOT NULL)
    OR ("status" = 'INVALID' AND "status_reason" IS NOT NULL AND "status_reason" = 'OPERATOR_REJECTED' AND "updated_by" IS NOT NULL)
    OR ("status" = 'INVALID' AND "status_reason" IS NOT NULL AND "status_reason" IN ('REMOVED_FROM_SITE', 'CUSTOMER_BAD_CONTACT_PATH'))
  ),
  CONSTRAINT "company_contact_point_data_class_check" CHECK ("data_class" = 'green'),
  CONSTRAINT "company_contact_point_source_check" CHECK (
    ("provider_key" = 'company_contact' AND "source_kind" IN ('homepage', 'contact_page'))
    OR ("provider_key" = 'operator' AND "source_kind" = 'operator')
  ),
  CONSTRAINT "company_contact_point_parser_version_check" CHECK ("parser_version" ~ '^[a-z][a-z0-9_]{0,40}/v[1-9][0-9]{0,3}$'),
  CONSTRAINT "company_contact_point_updated_by_check" CHECK ("updated_by" IS NULL OR char_length("updated_by") BETWEEN 1 AND 256),
  CONSTRAINT "company_contact_point_seen_check" CHECK ("first_seen_at" <= "last_seen_at"),
  CONSTRAINT "company_contact_point_company_fkey" FOREIGN KEY ("workspace_id", "company_id")
    REFERENCES "canonical_company"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "company_contact_point_workspace_id_company_id_kind_value_key"
  ON "company_contact_point"("workspace_id", "company_id", "kind", "value");

ALTER TABLE "company_contact_point" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_contact_point" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_contact_point_tenant_isolation" ON "company_contact_point"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "company_contact_point" TO app_user;

COMMIT;
