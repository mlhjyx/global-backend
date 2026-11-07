-- S1 Pack v1：Pack 目录 / 草稿 / 发布版本 / 激活 / 启停 / 评测回执 / 策略解析快照。
-- 七张新表，全部 additive。发布版本、激活、回执与策略快照 append-only；草稿与启停可写。
-- 平台表（无 workspace 维度）的隔离由授权（app_user 只读/仅插入）承担，策略为显式放行；
-- 租户表（activation 的 workspace 行 / enablement / strategy snapshot）走 current_workspace_id()。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "pack_package" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pack_key" TEXT NOT NULL,
    "pack_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "status_reason" VARCHAR(500),
    "status_updated_at" TIMESTAMP(3),
    "status_updated_by" TEXT,
    "active_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pack_package_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pack_package_pack_type_check" CHECK ("pack_type" IN ('compliance', 'data_source', 'growth_motion', 'industry')),
    CONSTRAINT "pack_package_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED'))
);

CREATE UNIQUE INDEX "pack_package_pack_key_key" ON "pack_package" ("pack_key");

CREATE TABLE "pack_draft" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" UUID NOT NULL,
    "draft_number" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "content" TEXT NOT NULL,
    "validation" JSONB,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pack_draft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pack_draft_number_positive" CHECK ("draft_number" > 0)
);

CREATE UNIQUE INDEX "pack_draft_package_id_draft_number_key" ON "pack_draft" ("package_id", "draft_number");

ALTER TABLE "pack_draft"
    ADD CONSTRAINT "pack_draft_package_fkey"
    FOREIGN KEY ("package_id") REFERENCES "pack_package" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "pack_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "content" TEXT NOT NULL,
    "manifest_digest" CHAR(64) NOT NULL,
    "content_digest" CHAR(64) NOT NULL,
    "schema_version" TEXT NOT NULL DEFAULT 'pack/v1',
    "published_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pack_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pack_version_manifest_digest_check" CHECK ("manifest_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "pack_version_content_digest_check" CHECK ("content_digest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "pack_version_package_id_version_key" ON "pack_version" ("package_id", "version");
CREATE UNIQUE INDEX "pack_version_package_id_manifest_digest_key" ON "pack_version" ("package_id", "manifest_digest");
CREATE UNIQUE INDEX "pack_version_id_package_id_key" ON "pack_version" ("id", "package_id");
CREATE INDEX "pack_version_package_created_idx" ON "pack_version" ("package_id", "created_at" DESC);

ALTER TABLE "pack_version"
    ADD CONSTRAINT "pack_version_package_fkey"
    FOREIGN KEY ("package_id") REFERENCES "pack_package" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pack_activation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "workspace_id" UUID,
    "canary" BOOLEAN NOT NULL DEFAULT false,
    "activated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pack_activation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pack_activation_scope_check" CHECK ("scope" IN ('platform', 'workspace')),
    CONSTRAINT "pack_activation_scope_workspace_check" CHECK (("scope" = 'platform') = ("workspace_id" IS NULL))
);

CREATE INDEX "pack_activation_package_scope_created_idx" ON "pack_activation" ("package_id", "scope", "workspace_id", "created_at" DESC);

ALTER TABLE "pack_activation"
    ADD CONSTRAINT "pack_activation_package_fkey"
    FOREIGN KEY ("package_id") REFERENCES "pack_package" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pack_activation"
    ADD CONSTRAINT "pack_activation_version_fkey"
    FOREIGN KEY ("version_id", "package_id") REFERENCES "pack_version" ("id", "package_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pack_enablement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" VARCHAR(500),
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pack_enablement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pack_enablement_workspace_id_package_id_key" ON "pack_enablement" ("workspace_id", "package_id");

ALTER TABLE "pack_enablement"
    ADD CONSTRAINT "pack_enablement_package_fkey"
    FOREIGN KEY ("package_id") REFERENCES "pack_package" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "eval_receipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_kind" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "subject_version" TEXT NOT NULL,
    "subject_digest" CHAR(64) NOT NULL,
    "eval_manifest_digest" CHAR(64) NOT NULL,
    "tier" TEXT NOT NULL,
    "model" TEXT,
    "passed" BOOLEAN NOT NULL,
    "cases_total" INTEGER NOT NULL,
    "cases_passed" INTEGER NOT NULL,
    "cost_micros" BIGINT,
    "run_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "eval_receipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "eval_receipt_subject_kind_check" CHECK ("subject_kind" IN ('skill', 'pack')),
    CONSTRAINT "eval_receipt_tier_check" CHECK ("tier" IN ('deterministic', 'model')),
    CONSTRAINT "eval_receipt_subject_digest_check" CHECK ("subject_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "eval_receipt_manifest_digest_check" CHECK ("eval_manifest_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "eval_receipt_cases_check" CHECK ("cases_total" >= 0 AND "cases_passed" >= 0 AND "cases_passed" <= "cases_total")
);

CREATE INDEX "eval_receipt_subject_created_idx" ON "eval_receipt" ("subject_kind", "subject_key", "created_at" DESC);

CREATE TABLE "strategy_resolution_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "skill_key" TEXT NOT NULL,
    "descriptor" JSONB NOT NULL,
    "descriptor_digest" CHAR(64) NOT NULL,
    "resolver_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "strategy_resolution_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "strategy_resolution_snapshot_digest_check" CHECK ("descriptor_digest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "strategy_resolution_snapshot_workspace_skill_digest_key"
    ON "strategy_resolution_snapshot" ("workspace_id", "skill_key", "descriptor_digest");
CREATE INDEX "strategy_resolution_snapshot_workspace_created_idx"
    ON "strategy_resolution_snapshot" ("workspace_id", "created_at");

-- RLS：平台表显式放行（无租户维度；写入由授权收紧），租户表按当前 workspace 隔离。
ALTER TABLE "pack_package" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pack_package" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pack_package_platform_access" ON "pack_package" USING (true) WITH CHECK (true);

ALTER TABLE "pack_draft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pack_draft" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pack_draft_platform_access" ON "pack_draft" USING (true) WITH CHECK (true);

ALTER TABLE "pack_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pack_version" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pack_version_platform_access" ON "pack_version" USING (true) WITH CHECK (true);

ALTER TABLE "pack_activation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pack_activation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pack_activation_scope_isolation" ON "pack_activation"
  USING ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id());

ALTER TABLE "pack_enablement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pack_enablement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pack_enablement_tenant_isolation" ON "pack_enablement"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "eval_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eval_receipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "eval_receipt_platform_access" ON "eval_receipt" USING (true) WITH CHECK (true);

ALTER TABLE "strategy_resolution_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "strategy_resolution_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "strategy_resolution_snapshot_tenant_isolation" ON "strategy_resolution_snapshot"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- app_user 授权（默认权限会授予全 CRUD，逐项收回）：
--   目录：SELECT + 仅状态/激活列 UPDATE；草稿：CRUD；发布版本/激活/回执/策略快照：append-only。
REVOKE ALL ON TABLE "pack_package" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "pack_package" FROM app_user;
GRANT SELECT ON TABLE "pack_package" TO app_user;
GRANT UPDATE ("status", "status_reason", "status_updated_at", "status_updated_by", "active_version_id", "updated_at")
  ON TABLE "pack_package" TO app_user;

REVOKE ALL ON TABLE "pack_draft" FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "pack_draft" FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pack_draft" TO app_user;

REVOKE ALL ON TABLE "pack_version" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "pack_version" FROM app_user;
GRANT SELECT ON TABLE "pack_version" TO app_user;

REVOKE ALL ON TABLE "pack_activation" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "pack_activation" FROM app_user;
GRANT SELECT, INSERT ON TABLE "pack_activation" TO app_user;

REVOKE ALL ON TABLE "pack_enablement" FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "pack_enablement" FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pack_enablement" TO app_user;

REVOKE ALL ON TABLE "eval_receipt" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "eval_receipt" FROM app_user;
GRANT SELECT, INSERT ON TABLE "eval_receipt" TO app_user;

REVOKE ALL ON TABLE "strategy_resolution_snapshot" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "strategy_resolution_snapshot" FROM app_user;
GRANT SELECT, INSERT ON TABLE "strategy_resolution_snapshot" TO app_user;

COMMIT;
