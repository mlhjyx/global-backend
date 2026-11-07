import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 静态契约（零容器）：S0 技能注册表迁移的建表/索引/RLS/app_user 授权。
 * 真库 as_user 行为由 app-user-table-privileges.postgres.spec.ts（CI PostgreSQL job）
 * 与 packages/db/test/skill-runtime.rls.spec.mjs（CI service 组）覆盖。
 */
const MIGRATIONS = fileURLToPath(new URL("../../../../packages/db/prisma/migrations/", import.meta.url));
const MIGRATION = "20261108010000_skill_runtime_v0";
const PRIVILEGES = fileURLToPath(
  new URL("../../../../docs/governance/app-user-table-privileges.json", import.meta.url),
);

function statements(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/u, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

describe("skill runtime v0 migration", () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, "utf8");
  const list = statements(sql);
  const flat = list.join("\n");

  it("is an additive bounded migration ordered after the seller-document work", () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf("20261105233000_discovery_company_materialization_pool_cap_reason"));
    expect(list[0]).toBe("BEGIN");
    expect(list.at(-1)).toBe("COMMIT");
    expect(list).toContain("SET LOCAL lock_timeout = '5s'");
    expect(list).toContain("SET LOCAL statement_timeout = '30s'");
  });

  it("creates the four registry tables with their integrity constraints", () => {
    for (const table of [
      "skill_package",
      "skill_version",
      "skill_enablement",
      "skill_resolution_snapshot",
    ]) {
      expect(list.some((statement) => statement.startsWith(`CREATE TABLE "${table}"`))).toBe(true);
    }
    expect(flat).toContain(
      'CONSTRAINT "skill_package_scope_workspace_check" CHECK (("scope" = \'platform\') = ("workspace_id" IS NULL))',
    );
    expect(flat).toContain(
      'CONSTRAINT "skill_package_status_check" CHECK ("status" IN (\'ACTIVE\', \'DISABLED\'))',
    );
    expect(list).toContain(
      'CREATE UNIQUE INDEX "skill_version_package_id_version_key" ON "skill_version" ("package_id", "version")',
    );
    expect(list).toContain(
      'CREATE UNIQUE INDEX "skill_enablement_workspace_id_package_id_key" ON "skill_enablement" ("workspace_id", "package_id")',
    );
    expect(list).toContain(
      'CREATE UNIQUE INDEX "skill_resolution_snapshot_workspace_skill_digest_key" ON "skill_resolution_snapshot" ("workspace_id", "skill_key", "descriptor_digest")',
    );
  });

  it("forces tenant RLS and keeps platform catalog rows readable across workspaces", () => {
    for (const table of [
      "skill_package",
      "skill_version",
      "skill_enablement",
      "skill_resolution_snapshot",
    ]) {
      expect(list).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(list).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(list).toContain('CREATE POLICY "skill_package_scope_isolation" ON "skill_package" USING ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id())');
    expect(list).toContain('CREATE POLICY "skill_enablement_tenant_isolation" ON "skill_enablement" USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())');
    expect(list).toContain('CREATE POLICY "skill_resolution_snapshot_tenant_isolation" ON "skill_resolution_snapshot" USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())');
  });

  it("keeps versions and snapshots append-only for app_user", () => {
    expect(list).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "skill_version" FROM app_user',
    );
    expect(list).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "skill_resolution_snapshot" FROM app_user',
    );
    expect(list).toContain('GRANT SELECT ON TABLE "skill_version" TO app_user');
    expect(list).toContain('GRANT SELECT, INSERT ON TABLE "skill_resolution_snapshot" TO app_user');
    expect(list).toContain(
      'GRANT UPDATE ("status", "status_reason", "status_updated_at", "status_updated_by", "updated_at") ON TABLE "skill_package" TO app_user',
    );
  });

  it("matches the governance privilege manifest", () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, "utf8")) as {
      tables: Record<string, string[]>;
      columns: Record<string, Record<string, string[]>>;
    };
    expect(manifest.tables["skill_package"]).toEqual(["SELECT"]);
    expect(manifest.tables["skill_version"]).toEqual(["SELECT"]);
    expect(manifest.tables["skill_enablement"]).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(manifest.tables["skill_resolution_snapshot"]).toEqual(["INSERT", "SELECT"]);
    expect(manifest.columns["skill_package"]).toEqual({
      status: ["UPDATE"],
      status_reason: ["UPDATE"],
      status_updated_at: ["UPDATE"],
      status_updated_by: ["UPDATE"],
      updated_at: ["UPDATE"],
    });
  });
});
