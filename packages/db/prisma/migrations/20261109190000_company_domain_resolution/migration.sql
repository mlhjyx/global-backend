-- ch03 §3.9.4 执行面批次 3a：域名解析候选/证据 + 人工复核队列（租户级，FORCE RLS）。
-- 只有 status='VERIFIED' 且 selected=true 的行驱动 canonical_company.domain 的写入
-- （写入路径随后续执行面 PR 接线）。同一公司至多一行 selected：DB 侧用部分唯一索引
-- 兜底（Prisma datamodel 无法表达部分索引，migrate diff 对部分索引整体忽略，见
-- 20261109130000_judgment_quality_v1 的同类说明）；写入路径另用 company 级 advisory
-- lock 串行化「先清旧选中再选新行」，避免并发选中在唯一索引上相撞。
-- Additive, no backfill.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "company_domain_resolution" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "candidate_domain" VARCHAR(253) NOT NULL,
  "route" VARCHAR(24) NOT NULL,
  "route_rank" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "match_type" VARCHAR(24),
  "confidence" DOUBLE PRECISION,
  "evidence_url" VARCHAR(2048),
  "evidence_hash" CHAR(64),
  "evidence_json" JSONB,
  "extractor_version" VARCHAR(64),
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "verified_at" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "company_domain_resolution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_domain_resolution_status_check" CHECK ("status" IN ('PENDING', 'VERIFIED', 'AMBIGUOUS', 'REJECTED', 'NOT_FOUND')),
  CONSTRAINT "company_domain_resolution_route_check" CHECK ("route" IN ('source_field', 'search', 'wikidata_p856', 'ct_log', 'cc_index', 'sitemap_hint', 'manual', 'none')),
  CONSTRAINT "company_domain_resolution_rank_check" CHECK ("route_rank" >= 0),
  CONSTRAINT "company_domain_resolution_domain_check" CHECK (char_length("candidate_domain") BETWEEN 1 AND 253),
  CONSTRAINT "company_domain_resolution_confidence_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100)),
  CONSTRAINT "company_domain_resolution_selected_check" CHECK ("selected" = false OR "status" = 'VERIFIED'),
  CONSTRAINT "company_domain_resolution_company_fkey" FOREIGN KEY ("workspace_id", "company_id")
    REFERENCES "canonical_company"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "company_domain_resolution_candidate_key"
  ON "company_domain_resolution"("workspace_id", "company_id", "candidate_domain", "route");
CREATE INDEX "company_domain_resolution_workspace_id_status_idx"
  ON "company_domain_resolution"("workspace_id", "status");
CREATE INDEX "company_domain_resolution_workspace_id_company_id_status_idx"
  ON "company_domain_resolution"("workspace_id", "company_id", "status");
-- 同一公司至多一行被选中（部分唯一索引；datamodel 无法表达，漂移 diff 忽略部分索引）。
CREATE UNIQUE INDEX "company_domain_resolution_selected_key"
  ON "company_domain_resolution"("workspace_id", "company_id") WHERE "selected";

ALTER TABLE "company_domain_resolution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_domain_resolution" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_domain_resolution_tenant_isolation" ON "company_domain_resolution"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "company_domain_resolution" TO app_user;

CREATE TABLE "domain_review_task" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "resolution_id" UUID NOT NULL,
  "reason" VARCHAR(64) NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 50,
  "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "assignee" TEXT,
  "due_at" TIMESTAMPTZ(3) NOT NULL,
  "decided_at" TIMESTAMPTZ(3),
  "decision_note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "domain_review_task_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "domain_review_task_reason_check" CHECK ("reason" IN ('low_confidence', 'name_collision', 'multi_candidates', 'audit_sample')),
  CONSTRAINT "domain_review_task_status_check" CHECK ("status" IN ('OPEN', 'APPROVED', 'REJECTED', 'NOT_FOUND', 'EXPIRED')),
  CONSTRAINT "domain_review_task_priority_check" CHECK ("priority" >= 0 AND "priority" <= 100),
  CONSTRAINT "domain_review_task_decided_check" CHECK ("status" = 'OPEN' OR "decided_at" IS NOT NULL),
  CONSTRAINT "domain_review_task_resolution_fkey" FOREIGN KEY ("resolution_id")
    REFERENCES "company_domain_resolution"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "domain_review_task_workspace_id_status_priority_idx"
  ON "domain_review_task"("workspace_id", "status", "priority");

ALTER TABLE "domain_review_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_review_task" FORCE ROW LEVEL SECURITY;
CREATE POLICY "domain_review_task_tenant_isolation" ON "domain_review_task"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "domain_review_task" TO app_user;

COMMIT;
