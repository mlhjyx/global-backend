-- S0 Skill Runtime v0（M1 步 7）：技能注册表 + 不可变解析快照。
-- 四张新表，全部 additive：skill_package / skill_version / skill_enablement / skill_resolution_snapshot。
-- 平台目录行（workspace_id IS NULL）对所有租户可读；解析快照与启停覆盖按 workspace 隔离。
-- 版本与快照 append-only：app_user 只有 SELECT（版本）与 SELECT+INSERT（快照）。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "skill_package" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "skill_key" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'platform',
    "workspace_id" UUID,
    "pack_type" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "status_reason" VARCHAR(500),
    "status_updated_at" TIMESTAMP(3),
    "status_updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_package_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "skill_package_scope_check" CHECK ("scope" IN ('platform', 'workspace')),
    CONSTRAINT "skill_package_scope_workspace_check" CHECK (("scope" = 'platform') = ("workspace_id" IS NULL)),
    CONSTRAINT "skill_package_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED'))
);

CREATE UNIQUE INDEX "skill_package_platform_key" ON "skill_package" ("skill_key") WHERE "workspace_id" IS NULL;
CREATE UNIQUE INDEX "skill_package_workspace_key" ON "skill_package" ("workspace_id", "skill_key") WHERE "workspace_id" IS NOT NULL;
CREATE UNIQUE INDEX "skill_package_id_workspace_id_key" ON "skill_package" ("id", "workspace_id");

CREATE TABLE "skill_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" UUID NOT NULL,
    "workspace_id" UUID,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "body_markdown" TEXT NOT NULL,
    "manifest_digest" CHAR(64) NOT NULL,
    "body_digest" CHAR(64) NOT NULL,
    "task_contract_id" TEXT NOT NULL,
    "task_contract_digest" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "skill_version_manifest_digest_check" CHECK ("manifest_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "skill_version_body_digest_check" CHECK ("body_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "skill_version_task_contract_digest_check" CHECK ("task_contract_digest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "skill_version_package_id_version_key" ON "skill_version" ("package_id", "version");
CREATE UNIQUE INDEX "skill_version_package_id_manifest_digest_key" ON "skill_version" ("package_id", "manifest_digest");
CREATE UNIQUE INDEX "skill_version_id_package_id_key" ON "skill_version" ("id", "package_id");
CREATE INDEX "skill_version_package_current_idx" ON "skill_version" ("package_id", "created_at" DESC, "id" DESC);

ALTER TABLE "skill_version"
    ADD CONSTRAINT "skill_version_package_workspace_fkey"
    FOREIGN KEY ("package_id", "workspace_id") REFERENCES "skill_package" ("id", "workspace_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "skill_enablement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" VARCHAR(500),
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_enablement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skill_enablement_workspace_id_package_id_key" ON "skill_enablement" ("workspace_id", "package_id");

ALTER TABLE "skill_enablement"
    ADD CONSTRAINT "skill_enablement_package_fkey"
    FOREIGN KEY ("package_id") REFERENCES "skill_package" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "skill_resolution_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "skill_key" TEXT NOT NULL,
    "package_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "descriptor" JSONB NOT NULL,
    "descriptor_digest" CHAR(64) NOT NULL,
    "resolver_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_resolution_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "skill_resolution_snapshot_descriptor_digest_check" CHECK ("descriptor_digest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "skill_resolution_snapshot_workspace_skill_digest_key"
    ON "skill_resolution_snapshot" ("workspace_id", "skill_key", "descriptor_digest");
CREATE INDEX "skill_resolution_snapshot_workspace_created_idx"
    ON "skill_resolution_snapshot" ("workspace_id", "created_at");

ALTER TABLE "skill_resolution_snapshot"
    ADD CONSTRAINT "skill_resolution_snapshot_package_fkey"
    FOREIGN KEY ("package_id") REFERENCES "skill_package" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "skill_resolution_snapshot"
    ADD CONSTRAINT "skill_resolution_snapshot_version_fkey"
    FOREIGN KEY ("version_id", "package_id") REFERENCES "skill_version" ("id", "package_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS：平台目录（workspace_id IS NULL）对所有空间可读；workspace 行只见本空间。
ALTER TABLE "skill_package" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_package" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_package_scope_isolation" ON "skill_package"
  USING ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id());

ALTER TABLE "skill_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_version" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_version_scope_isolation" ON "skill_version"
  USING ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id());

ALTER TABLE "skill_enablement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_enablement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_enablement_tenant_isolation" ON "skill_enablement"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "skill_resolution_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_resolution_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "skill_resolution_snapshot_tenant_isolation" ON "skill_resolution_snapshot"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- app_user（最小授权；默认权限会授予全 CRUD，这里逐项收回）：
--   目录：SELECT + 仅状态列 UPDATE（ops kill switch）；版本：只读（append-only）；
--   启停覆盖：读写；快照：SELECT + INSERT（append-only，不可改不可删）。
REVOKE ALL ON TABLE "skill_package" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "skill_package" FROM app_user;
GRANT SELECT ON TABLE "skill_package" TO app_user;
GRANT UPDATE ("status", "status_reason", "status_updated_at", "status_updated_by", "updated_at")
  ON TABLE "skill_package" TO app_user;

REVOKE ALL ON TABLE "skill_version" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "skill_version" FROM app_user;
GRANT SELECT ON TABLE "skill_version" TO app_user;

REVOKE ALL ON TABLE "skill_enablement" FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "skill_enablement" FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "skill_enablement" TO app_user;

REVOKE ALL ON TABLE "skill_resolution_snapshot" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "skill_resolution_snapshot" FROM app_user;
GRANT SELECT, INSERT ON TABLE "skill_resolution_snapshot" TO app_user;

COMMIT;
