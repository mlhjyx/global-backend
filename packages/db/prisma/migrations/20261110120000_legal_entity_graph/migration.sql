-- 获客挖掘 vNext W2（2026-11-10）：实体级消歧与公司图谱。
-- 权威计划：docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md §3 W2 / §4。
--
-- 设计说明（workspace 维度选定）：两张表都是**租户级**表（workspace_id + ENABLE/FORCE RLS +
-- current_workspace_id() 策略）。依据两点：① 计划 §4 明确「均带 workspace RLS（平台级表除外：
-- compliance matrix 为平台表）」；② 现行数据治理约定里，凡由某 workspace 的公司/证据派生的行都按
-- 租户隔离（registry_frame 是无主参考源、保持平台级；legal_entity 是公司身份事实，按租户存）。
-- 跨租户共享法人实体（平台级实体注册库）不在本 PR，后续如需由 W4 源装载层引入平台表并只读放开。
--
-- 为什么 legal_entity 的键含 country：同一 scheme 的编号并非处处全球唯一——LEI 全球唯一，
-- 但 HRB 按德国登记法院分配（"HRB 12345" 在多个 Amtsgericht 各有一家），KVK/CVR 等只在
-- 本国唯一。唯一键 (workspace_id, scheme, country, value) 让「同名异地/同号异院」不塌成一行。
--
-- company_legal_link 的匹配纪律（引擎见 apps/api/src/discovery/entity/）：
--   * deterministic（LEI / 注册号 / SIREN / CH / KVK / CVR / bolagsverket 等硬键）→ 可 auto；
--   * VAT 在税组（Organschaft）可跨法人共享：VIES 校验通过前落 review；HRB 因按法院分配同号
--     风险，同样落 review；两类只在证据充分时由人工转 auto（本 PR 不含人工复核端点）。
--   * probabilistic（Fellegi–Sunter 双阈值）→ auto / review 两档，低于 review 阈值不落 link。
--   * 绝不自动合并两个已存在的 canonical 公司：link 只表达「公司 ↔ 法人实体」，合并另行人工。
--   * 已判定冲突（同 scheme 确定性键两侧不同值）→ status='rejected' 留档，不产生 auto/review。
--
-- Additive, no backfill. 幂等：唯一键 + 服务层 upsert（同对只升不降）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "legal_entity" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "scheme" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "country" CHAR(2) NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "source_provider" VARCHAR(64) NOT NULL,
  "evidence_url" VARCHAR(2048),
  "evidence_hash" CHAR(64),
  "evidence_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "legal_entity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_entity_scheme_check" CHECK ("scheme" IN ('lei', 'vat', 'hrb', 'siren', 'ch', 'kvk', 'cvr', 'bolagsverket', 'other')),
  CONSTRAINT "legal_entity_status_check" CHECK ("status" IN ('active', 'inactive', 'dissolved', 'unknown')),
  CONSTRAINT "legal_entity_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "legal_entity_value_check" CHECK (char_length("value") BETWEEN 1 AND 128),
  CONSTRAINT "legal_entity_name_check" CHECK (char_length("name") BETWEEN 1 AND 512),
  CONSTRAINT "legal_entity_evidence_hash_check" CHECK ("evidence_hash" IS NULL OR "evidence_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "legal_entity_workspace_id_scheme_country_value_key" UNIQUE ("workspace_id", "scheme", "country", "value"),
  CONSTRAINT "legal_entity_workspace_id_id_key" UNIQUE ("workspace_id", "id")
);

CREATE INDEX "legal_entity_workspace_id_country_idx" ON "legal_entity"("workspace_id", "country");
CREATE INDEX "legal_entity_workspace_id_scheme_value_idx" ON "legal_entity"("workspace_id", "scheme", "value");

CREATE TABLE "company_legal_link" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "legal_entity_id" UUID NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "match_method" TEXT NOT NULL,
  "match_rule" VARCHAR(48) NOT NULL,
  "status" TEXT NOT NULL,
  "evidence_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "company_legal_link_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_legal_link_method_check" CHECK ("match_method" IN ('deterministic', 'probabilistic')),
  CONSTRAINT "company_legal_link_status_check" CHECK ("status" IN ('auto', 'review', 'rejected')),
  CONSTRAINT "company_legal_link_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "company_legal_link_company_fkey" FOREIGN KEY ("company_id")
    REFERENCES "canonical_company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- 复合外键杜绝跨租户挂靠：link 行的 workspace_id 必须与实体行的一致（FK 校验绕过 RLS，
  -- 单列外键挡不住「WS-A 的 link 指向 WS-B 的实体」）。
  CONSTRAINT "company_legal_link_legal_entity_fkey" FOREIGN KEY ("workspace_id", "legal_entity_id")
    REFERENCES "legal_entity"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "company_legal_link_workspace_id_company_id_legal_entity_id_key" UNIQUE ("workspace_id", "company_id", "legal_entity_id")
);

CREATE INDEX "company_legal_link_workspace_id_company_id_idx" ON "company_legal_link"("workspace_id", "company_id");
CREATE INDEX "company_legal_link_workspace_id_legal_entity_id_idx" ON "company_legal_link"("workspace_id", "legal_entity_id");
CREATE INDEX "company_legal_link_workspace_id_status_idx" ON "company_legal_link"("workspace_id", "status");

ALTER TABLE "legal_entity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_entity" FORCE ROW LEVEL SECURITY;
CREATE POLICY "legal_entity_tenant_isolation" ON "legal_entity"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "company_legal_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_legal_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_legal_link_tenant_isolation" ON "company_legal_link"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "legal_entity" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "company_legal_link" TO app_user;

COMMIT;
