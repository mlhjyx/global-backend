-- M10-PR2: ADR-003 physical `platform_shared` schema boundary (Layer 1 green corporate facts & HMAC cooldowns).
-- Hard physical isolation invariants:
--   1. Dedicated `platform_shared` schema, completely separate from tenant `public` tables.
--   2. Dedicated `platform_writer` role (NOSUPERUSER) holds read/write privileges;
--      `app_user` (tenant runtime role) is strictly SELECT-only (`REVOKE INSERT, UPDATE, DELETE, TRUNCATE`).
--   3. Structurally zero natural-person PII columns (`person_name`, `personal_email`, `personal_linkedin`,
--      `workspace_id`, `raw_html`) + DB-level CHECK constraints & trigger rejecting personal emails,
--      personal LinkedIn URLs, inline email PII in summaries, non-green sources, and non-HMAC cooldown keys.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_writer') THEN
    CREATE ROLE platform_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS platform_shared;

CREATE TABLE IF NOT EXISTS platform_shared.company_fact (
  domain TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'adr003-green-company-fact/v1',
  homepage_url TEXT NOT NULL,
  legal_name TEXT,
  country CHAR(2),
  trade_role TEXT NOT NULL DEFAULT 'unknown',
  website_summary TEXT,
  role_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  switchboard_phones JSONB NOT NULL DEFAULT '[]'::jsonb,
  inquiry_form_url TEXT,
  contact_page_url TEXT,
  impressum_url TEXT,
  linkedin_company_url TEXT,
  product_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_kind TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  ttl_days INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive structural guards (NOT VALID + VALIDATE CONSTRAINT for lock safety).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_shared_company_fact_domain_chk'
      AND conrelid = 'platform_shared.company_fact'::regclass
  ) THEN
    ALTER TABLE platform_shared.company_fact
      ADD CONSTRAINT platform_shared_company_fact_domain_chk
      CHECK (
        domain = lower(domain)
        AND char_length(domain) BETWEEN 4 AND 253
        AND domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        AND domain !~ '^[0-9.]+$'
      ) NOT VALID;
    ALTER TABLE platform_shared.company_fact
      VALIDATE CONSTRAINT platform_shared_company_fact_domain_chk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_shared_company_fact_source_kind_chk'
      AND conrelid = 'platform_shared.company_fact'::regclass
  ) THEN
    ALTER TABLE platform_shared.company_fact
      ADD CONSTRAINT platform_shared_company_fact_source_kind_chk
      CHECK (
        source_kind IN ('public_web_streaming', 'public_web', 'public_registry', 'public_directory')
      ) NOT VALID;
    ALTER TABLE platform_shared.company_fact
      VALIDATE CONSTRAINT platform_shared_company_fact_source_kind_chk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_shared_company_fact_ttl_chk'
      AND conrelid = 'platform_shared.company_fact'::regclass
  ) THEN
    ALTER TABLE platform_shared.company_fact
      ADD CONSTRAINT platform_shared_company_fact_ttl_chk
      CHECK (ttl_days BETWEEN 14 AND 30 AND expires_at > observed_at) NOT VALID;
    ALTER TABLE platform_shared.company_fact
      VALIDATE CONSTRAINT platform_shared_company_fact_ttl_chk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_shared_company_fact_no_personal_linkedin_chk'
      AND conrelid = 'platform_shared.company_fact'::regclass
  ) THEN
    ALTER TABLE platform_shared.company_fact
      ADD CONSTRAINT platform_shared_company_fact_no_personal_linkedin_chk
      CHECK (
        linkedin_company_url IS NULL
        OR (
          linkedin_company_url ~* '^https://www\.linkedin\.com/company/[a-z0-9][a-z0-9._-]{0,120}$'
          AND linkedin_company_url !~* '/(in|pub)/'
        )
      ) NOT VALID;
    ALTER TABLE platform_shared.company_fact
      VALIDATE CONSTRAINT platform_shared_company_fact_no_personal_linkedin_chk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_shared_company_fact_no_pii_summary_chk'
      AND conrelid = 'platform_shared.company_fact'::regclass
  ) THEN
    ALTER TABLE platform_shared.company_fact
      ADD CONSTRAINT platform_shared_company_fact_no_pii_summary_chk
      CHECK (
        website_summary IS NULL
        OR (
          char_length(website_summary) <= 400
          AND website_summary !~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
          AND website_summary !~* 'linkedin\.com/(in|pub)/'
        )
      ) NOT VALID;
    ALTER TABLE platform_shared.company_fact
      VALIDATE CONSTRAINT platform_shared_company_fact_no_pii_summary_chk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_shared_company_fact_json_arrays_chk'
      AND conrelid = 'platform_shared.company_fact'::regclass
  ) THEN
    ALTER TABLE platform_shared.company_fact
      ADD CONSTRAINT platform_shared_company_fact_json_arrays_chk
      CHECK (
        jsonb_typeof(role_emails) = 'array'
        AND jsonb_array_length(role_emails) <= 10
        AND jsonb_typeof(switchboard_phones) = 'array'
        AND jsonb_array_length(switchboard_phones) <= 3
        AND jsonb_typeof(product_categories) = 'array'
        AND jsonb_array_length(product_categories) <= 12
      ) NOT VALID;
    ALTER TABLE platform_shared.company_fact
      VALIDATE CONSTRAINT platform_shared_company_fact_json_arrays_chk;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS platform_shared_company_fact_expires_idx
  ON platform_shared.company_fact (expires_at);

-- Database-layer PII guard: every element in role_emails must be a strict departmental
-- role mailbox on the company domain (never personal local-parts or free webmail).
CREATE OR REPLACE FUNCTION platform_shared.assert_company_fact_no_pii()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  item TEXT;
  at_pos INTEGER;
  local_part TEXT;
  host_part TEXT;
  parts TEXT[];
  allowed_prefixes CONSTANT TEXT[] := ARRAY[
    'info','sales','contact','export','import','procurement','purchasing','buyer','buying',
    'commercial','commerciale','vendite','vertrieb','einkauf','anfrage','kontakt','office',
    'hello','b2b','wholesale','distribution','distribuzione','grosshandel','partner','partners',
    'support','service','enquiries','inquiries','inquiry','rfq','tender','orders','order',
    'mail','trade','marketing','admin','general','help','billing','accounts','logistics',
    'supply','sourcing','press','media','legal','compliance','privacy','impressum','datenschutz'
  ];
  allowed_suffixes CONSTANT TEXT[] := ARRAY[
    'de','eu','us','uk','it','fr','es','nl','at','ch','pl','se','no','dk','be',
    'jp','cn','au','ca','br','mx','apac','emea','dach','na','latam','intl','global',
    'b2b','team','dept','desk','hq','office','sales','export','support','service',
    'wholesale','orders','inquiry','info'
  ];
BEGIN
  IF NEW.legal_name IS NOT NULL AND (
    NEW.legal_name ~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    OR NEW.legal_name ~* 'linkedin\.com/(in|pub)/'
  ) THEN
    RAISE EXCEPTION 'ADR003_PII_FORBIDDEN_IN_LEGAL_NAME' USING ERRCODE = '23514';
  END IF;

  FOR item IN SELECT jsonb_array_elements_text(NEW.product_categories)
  LOOP
    IF item ~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
      OR item ~* 'linkedin\.com/(in|pub)/'
    THEN
      RAISE EXCEPTION 'ADR003_PII_FORBIDDEN_IN_PRODUCT_CATEGORIES' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR item IN SELECT jsonb_array_elements_text(NEW.role_emails)
  LOOP
    item := lower(btrim(item));
    at_pos := strpos(item, '@');
    IF at_pos <= 1 OR strpos(substring(item FROM at_pos + 1), '@') > 0 THEN
      RAISE EXCEPTION 'ADR003_INVALID_ROLE_EMAIL' USING ERRCODE = '23514';
    END IF;
    local_part := substring(item FROM 1 FOR at_pos - 1);
    host_part := substring(item FROM at_pos + 1);
    IF host_part <> NEW.domain AND host_part NOT LIKE ('%.' || NEW.domain) THEN
      RAISE EXCEPTION 'ADR003_OFFDOMAIN_ROLE_EMAIL_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
    IF NOT (local_part = ANY(allowed_prefixes)) THEN
      parts := regexp_split_to_array(local_part, '[._+-]');
      IF array_length(parts, 1) IS DISTINCT FROM 2
        OR NOT (parts[1] = ANY(allowed_prefixes))
        OR NOT (parts[2] = ANY(allowed_suffixes) OR parts[2] ~ '^[0-9]{1,2}$')
      THEN
        RAISE EXCEPTION 'ADR003_PERSONAL_EMAIL_FORBIDDEN' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_platform_shared_company_fact_no_pii ON platform_shared.company_fact;

CREATE TRIGGER trg_platform_shared_company_fact_no_pii
  BEFORE INSERT OR UPDATE ON platform_shared.company_fact
  FOR EACH ROW
  EXECUTE FUNCTION platform_shared.assert_company_fact_no_pii();

-- Layer 1 cross-tenant 30-day outreach/discovery cooldown window (HMAC-SHA256 only, zero raw domains/tenant IDs).
CREATE TABLE IF NOT EXISTS platform_shared.domain_cooldown_touch (
  domain_hmac CHAR(64) NOT NULL,
  workspace_touch_hmac CHAR(64) NOT NULL,
  touched_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (domain_hmac, workspace_touch_hmac)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_shared_cooldown_hmac_chk'
      AND conrelid = 'platform_shared.domain_cooldown_touch'::regclass
  ) THEN
    ALTER TABLE platform_shared.domain_cooldown_touch
      ADD CONSTRAINT platform_shared_cooldown_hmac_chk
      CHECK (
        domain_hmac ~ '^[0-9a-f]{64}$'
        AND workspace_touch_hmac ~ '^[0-9a-f]{64}$'
        AND expires_at > touched_at
      ) NOT VALID;
    ALTER TABLE platform_shared.domain_cooldown_touch
      VALIDATE CONSTRAINT platform_shared_cooldown_hmac_chk;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS platform_shared_cooldown_expires_idx
  ON platform_shared.domain_cooldown_touch (expires_at);

-- Strict physical privilege boundary:
--   * PUBLIC: zero access
--   * platform_writer (and execution_budget_platform_writer if present): USAGE + SELECT/INSERT/UPDATE/DELETE
--   * app_user (if present): USAGE + SELECT ONLY (never INSERT/UPDATE/DELETE/TRUNCATE)
--   * Per G5 (rls-catalog-gate), future tables in platform_shared must grant privileges explicitly
--     in their creating migration instead of mutating global pg_default_acl entries.
REVOKE ALL ON SCHEMA platform_shared FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA platform_shared FROM PUBLIC;

GRANT USAGE ON SCHEMA platform_shared TO platform_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform_shared TO platform_writer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'execution_budget_platform_writer') THEN
    GRANT USAGE ON SCHEMA platform_shared TO execution_budget_platform_writer;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform_shared TO execution_budget_platform_writer;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON SCHEMA platform_shared FROM app_user;
    REVOKE ALL ON ALL TABLES IN SCHEMA platform_shared FROM app_user;
    GRANT USAGE ON SCHEMA platform_shared TO app_user;
    GRANT SELECT ON ALL TABLES IN SCHEMA platform_shared TO app_user;
  END IF;
END
$$;
