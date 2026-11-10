-- 获客挖掘 vNext W3（评估学与产出会计，2026-11-10）：四张表。
--
-- 设计依据：docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md §3 W3——
--   * evaluation_set / evaluation_label：golden set 标注队列 + 版本化快照，
--     支撑 precision@k 报告（GET /evaluation/sets/:id/report）；
--   * source_yield_ledger：逐 (run, 源, 查询) 的边际产出账本（记录数/新增合格数/
--     实扣成本 microusd），finalizeRun 同事务写入，历史 run 由
--     apps/api/scripts/backfill-source-yield-ledger.mts 回填；
--   * coverage_estimate：双源捕获-再捕获（Chapman）覆盖估计的存证行。
--
-- 权限语义（与 docs/governance/app-user-table-privileges.json 对账）：
--   * 四表均为租户表：ENABLE + FORCE ROW LEVEL SECURITY，策略按 current_workspace_id()；
--   * evaluation_set / evaluation_label 是人工标注工件：set 只插不改（版本化用新行），
--     label 允许 UPDATE（同集同候选键重标注即覆盖）；
--   * source_yield_ledger / coverage_estimate 是 append-only 事实：SELECT + INSERT，
--     无 UPDATE/DELETE。
--
-- 与 Prisma datamodel 对齐：约束名均用 schema 中显式 map 的名字，时间戳
-- TIMESTAMPTZ(3)、id 走 gen_random_uuid()，避免漂移门误报。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ① 评估集（名称+版本唯一；ICP 口径可空，ICP 删除时置空保留历史）。
CREATE TABLE "evaluation_set" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "icp_id" UUID,
  "description" TEXT,
  "created_by" VARCHAR(200),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "evaluation_set_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evaluation_set_workspace_id_id_key" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "evaluation_set_workspace_id_name_version_key"
    UNIQUE ("workspace_id", "name", "version"),
  CONSTRAINT "evaluation_set_version_check" CHECK ("version" >= 1),
  CONSTRAINT "evaluation_set_icp_id_fkey" FOREIGN KEY ("icp_id")
    REFERENCES "icp_definition"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE INDEX "evaluation_set_workspace_idx" ON "evaluation_set" ("workspace_id");

-- ② 集内标注：候选引用三选一（canonical_company_id / domain / name），
--    candidate_key 是规范化身份键（应用层生成），同集同键唯一 = 重标注覆盖。
CREATE TABLE "evaluation_label" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "set_id" UUID NOT NULL,
  "canonical_company_id" UUID,
  "domain" VARCHAR(253),
  "name" VARCHAR(400),
  "country" VARCHAR(64),
  "label" VARCHAR(8) NOT NULL,
  "candidate_key" VARCHAR(400) NOT NULL,
  "labeled_by" VARCHAR(200) NOT NULL,
  "labeled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,

  CONSTRAINT "evaluation_label_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evaluation_label_label_check" CHECK ("label" IN ('POSITIVE', 'NEGATIVE')),
  CONSTRAINT "evaluation_label_candidate_check" CHECK (
    "canonical_company_id" IS NOT NULL
    OR ("domain" IS NOT NULL AND btrim("domain") <> '')
    OR ("name" IS NOT NULL AND btrim("name") <> '')
  ),
  -- 复合外键把 label 钉在同 workspace 的 set 上（RLS 之外的纵深防御）。
  CONSTRAINT "evaluation_label_set_fkey" FOREIGN KEY ("workspace_id", "set_id")
    REFERENCES "evaluation_set"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "evaluation_label_set_id_candidate_key_key" UNIQUE ("set_id", "candidate_key")
);
CREATE INDEX "evaluation_label_workspace_set_idx" ON "evaluation_label" ("workspace_id", "set_id");
CREATE INDEX "evaluation_label_company_idx" ON "evaluation_label" ("workspace_id", "canonical_company_id");

-- ③ 边际产出账本（append-only；finalizeRun 同事务写入，重试靠唯一键幂等）。
CREATE TABLE "source_yield_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "provider_key" VARCHAR(128) NOT NULL,
  "query_key" CHAR(64) NOT NULL,
  "record_count" BIGINT NOT NULL,
  "new_qualified_count" BIGINT NOT NULL,
  "cost_microusd" BIGINT NOT NULL,
  "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "source_yield_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_yield_ledger_record_count_check" CHECK ("record_count" >= 0),
  CONSTRAINT "source_yield_ledger_new_qualified_check" CHECK ("new_qualified_count" >= 0),
  CONSTRAINT "source_yield_ledger_cost_check" CHECK ("cost_microusd" >= 0),
  CONSTRAINT "source_yield_ledger_run_provider_query_key"
    UNIQUE ("workspace_id", "run_id", "provider_key", "query_key"),
  CONSTRAINT "source_yield_ledger_run_fkey" FOREIGN KEY ("workspace_id", "run_id")
    REFERENCES "discovery_run"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "source_yield_ledger_workspace_computed_idx"
  ON "source_yield_ledger" ("workspace_id", "computed_at");

-- ④ 覆盖估计存证（append-only）：identity_key = sha256(口径+计数)，计数变化才追一行。
CREATE TABLE "coverage_estimate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "region" VARCHAR(80) NOT NULL,
  "category" VARCHAR(200) NOT NULL,
  "source_a" VARCHAR(128) NOT NULL,
  "source_b" VARCHAR(128) NOT NULL,
  "count_a" INTEGER NOT NULL,
  "count_b" INTEGER NOT NULL,
  "overlap_count" INTEGER NOT NULL,
  "estimate" NUMERIC(20, 6),
  "ci_low" NUMERIC(20, 6),
  "ci_high" NUMERIC(20, 6),
  "estimator" VARCHAR(32) NOT NULL DEFAULT 'chapman/v1',
  "identity_key" CHAR(64) NOT NULL,
  "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "coverage_estimate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coverage_estimate_workspace_identity_key"
    UNIQUE ("workspace_id", "identity_key"),
  CONSTRAINT "coverage_estimate_counts_check"
    CHECK ("count_a" >= 0 AND "count_b" >= 0 AND "overlap_count" >= 0),
  CONSTRAINT "coverage_estimate_overlap_check"
    CHECK ("overlap_count" <= LEAST("count_a", "count_b"))
);
CREATE INDEX "coverage_estimate_workspace_computed_idx"
  ON "coverage_estimate" ("workspace_id", "computed_at");

-- ⑤ 租户隔离与权限。
ALTER TABLE "evaluation_set" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evaluation_set" FORCE ROW LEVEL SECURITY;
CREATE POLICY "evaluation_set_tenant_isolation" ON "evaluation_set"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "evaluation_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evaluation_label" FORCE ROW LEVEL SECURITY;
CREATE POLICY "evaluation_label_tenant_isolation" ON "evaluation_label"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "source_yield_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_yield_ledger" FORCE ROW LEVEL SECURITY;
CREATE POLICY "source_yield_ledger_tenant_isolation" ON "source_yield_ledger"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "coverage_estimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coverage_estimate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "coverage_estimate_tenant_isolation" ON "coverage_estimate"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "evaluation_set" FROM PUBLIC;
REVOKE ALL ON TABLE "evaluation_label" FROM PUBLIC;
REVOKE ALL ON TABLE "source_yield_ledger" FROM PUBLIC;
REVOKE ALL ON TABLE "coverage_estimate" FROM PUBLIC;

-- set 只插不改；label 可覆盖重标注；两张事实表 append-only。
GRANT SELECT, INSERT ON TABLE "evaluation_set" TO app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "evaluation_label" TO app_user;
GRANT SELECT, INSERT ON TABLE "source_yield_ledger" TO app_user;
GRANT SELECT, INSERT ON TABLE "coverage_estimate" TO app_user;

COMMIT;
