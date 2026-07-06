-- CreateTable
CREATE TABLE "data_provider" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ENABLED',
    "cost_per_call_cents" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_run" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "icp_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "stats" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "discovery_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_source_record" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "source_class" TEXT NOT NULL,
    "external_id" TEXT,
    "payload" JSONB NOT NULL,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_source_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_company" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "country" TEXT,
    "region" TEXT,
    "industry" TEXT,
    "employee_count" INTEGER,
    "revenue_usd" DOUBLE PRECISION,
    "attributes" JSONB,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "dedupe_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canonical_company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_contact" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "title" TEXT,
    "seniority" TEXT,
    "department" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_point" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_link" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "canonical_type" TEXT NOT NULL,
    "canonical_id" UUID NOT NULL,
    "raw_record_id" UUID NOT NULL,
    "match_rule" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_evidence" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "provider_key" TEXT NOT NULL,
    "raw_record_id" UUID,
    "confidence" DOUBLE PRECISION,
    "license" TEXT NOT NULL DEFAULT 'sandbox',
    "allowed_actions" JSONB,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_record" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_provider_key_key" ON "data_provider"("key");

-- CreateIndex
CREATE INDEX "discovery_run_workspace_id_idx" ON "discovery_run"("workspace_id");

-- CreateIndex
CREATE INDEX "discovery_run_plan_id_idx" ON "discovery_run"("plan_id");

-- CreateIndex
CREATE INDEX "raw_source_record_workspace_id_idx" ON "raw_source_record"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "raw_source_record_run_id_provider_key_external_id_key" ON "raw_source_record"("run_id", "provider_key", "external_id");

-- CreateIndex
CREATE INDEX "canonical_company_workspace_id_idx" ON "canonical_company"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_company_workspace_id_dedupe_key_key" ON "canonical_company"("workspace_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "canonical_contact_workspace_id_idx" ON "canonical_contact"("workspace_id");

-- CreateIndex
CREATE INDEX "canonical_contact_company_id_idx" ON "canonical_contact"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_contact_workspace_id_dedupe_key_key" ON "canonical_contact"("workspace_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "contact_point_workspace_id_idx" ON "contact_point"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_point_contact_id_type_value_key" ON "contact_point"("contact_id", "type", "value");

-- CreateIndex
CREATE INDEX "identity_link_workspace_id_idx" ON "identity_link"("workspace_id");

-- CreateIndex
CREATE INDEX "identity_link_canonical_id_idx" ON "identity_link"("canonical_id");

-- CreateIndex
CREATE INDEX "field_evidence_workspace_id_idx" ON "field_evidence"("workspace_id");

-- CreateIndex
CREATE INDEX "field_evidence_workspace_id_entity_type_entity_id_idx" ON "field_evidence"("workspace_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "suppression_record_workspace_id_idx" ON "suppression_record"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_record_workspace_id_type_value_key" ON "suppression_record"("workspace_id", "type", "value");

-- AddForeignKey
ALTER TABLE "raw_source_record" ADD CONSTRAINT "raw_source_record_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "discovery_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_contact" ADD CONSTRAINT "canonical_contact_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "canonical_company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_point" ADD CONSTRAINT "contact_point_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "canonical_contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Row-Level Security (ADR-001)：租户表全部隔离；data_provider 是平台配置表，无租户数据，不启 RLS ──
ALTER TABLE "discovery_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discovery_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY "discovery_run_tenant_isolation" ON "discovery_run"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "raw_source_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "raw_source_record" FORCE ROW LEVEL SECURITY;
CREATE POLICY "raw_source_record_tenant_isolation" ON "raw_source_record"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "canonical_company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_company" FORCE ROW LEVEL SECURITY;
CREATE POLICY "canonical_company_tenant_isolation" ON "canonical_company"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "canonical_contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_contact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "canonical_contact_tenant_isolation" ON "canonical_contact"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "contact_point" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_point" FORCE ROW LEVEL SECURITY;
CREATE POLICY "contact_point_tenant_isolation" ON "contact_point"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "identity_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY "identity_link_tenant_isolation" ON "identity_link"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "field_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "field_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "field_evidence_tenant_isolation" ON "field_evidence"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "suppression_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppression_record" FORCE ROW LEVEL SECURITY;
CREATE POLICY "suppression_record_tenant_isolation" ON "suppression_record"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "discovery_run", "raw_source_record", "canonical_company", "canonical_contact",
  "contact_point", "identity_link", "field_evidence", "suppression_record" TO app_user;
GRANT SELECT ON "data_provider" TO app_user;
