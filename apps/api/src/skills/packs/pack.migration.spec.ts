import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 静态契约（零容器）：S1-2 的两条迁移（pack 七表 + skill_version service 绑定）。
 * 真库 ACL 由 app-user-table-privileges.postgres.spec.ts（CI）与
 * packages/db/test/pack-runtime.rls.spec.mjs（service 组）覆盖。
 */
const MIGRATIONS = fileURLToPath(new URL("../../../../../packages/db/prisma/migrations/", import.meta.url));
const PACK_MIGRATION = "20261108130000_pack_v1";
const SKILL_KIND_MIGRATION = "20261108130100_skill_service_kind";
const PRIVILEGES = fileURLToPath(
  new URL("../../../../../docs/governance/app-user-table-privileges.json", import.meta.url),
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

describe("pack v1 migrations", () => {
  const packSql = readFileSync(`${MIGRATIONS}${PACK_MIGRATION}/migration.sql`, "utf8");
  const packList = statements(packSql);
  const flat = packList.join("\n");

  it("is an additive bounded migration after the skill runtime work", () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(PACK_MIGRATION);
    expect(names).toContain(SKILL_KIND_MIGRATION);
    expect(names.indexOf(PACK_MIGRATION)).toBeGreaterThan(
      names.indexOf("20261108010000_skill_runtime_v0"),
    );
    expect(packList[0]).toBe("BEGIN");
    expect(packList.at(-1)).toBe("COMMIT");
    expect(packList).toContain("SET LOCAL lock_timeout = '5s'");
    expect(packList).toContain("SET LOCAL statement_timeout = '30s'");
  });

  it("creates the seven pack tables with their integrity constraints", () => {
    for (const table of [
      "pack_package",
      "pack_draft",
      "pack_version",
      "pack_activation",
      "pack_enablement",
      "eval_receipt",
      "strategy_resolution_snapshot",
    ]) {
      expect(packList.some((statement) => statement.startsWith(`CREATE TABLE "${table}"`))).toBe(true);
    }
    expect(flat).toContain(
      'CONSTRAINT "pack_activation_scope_workspace_check" CHECK (("scope" = \'platform\') = ("workspace_id" IS NULL))',
    );
    expect(flat).toContain(
      'CONSTRAINT "eval_receipt_cases_check" CHECK ("cases_total" >= 0 AND "cases_passed" >= 0 AND "cases_passed" <= "cases_total")',
    );
    expect(packList).toContain(
      'CREATE UNIQUE INDEX "strategy_resolution_snapshot_workspace_skill_digest_key" ON "strategy_resolution_snapshot" ("workspace_id", "skill_key", "descriptor_digest")',
    );
    expect(packList).toContain(
      'CREATE UNIQUE INDEX "pack_version_package_id_version_key" ON "pack_version" ("package_id", "version")',
    );
  });

  it("forces RLS and isolates tenant-scoped rows", () => {
    for (const table of [
      "pack_package",
      "pack_draft",
      "pack_version",
      "pack_activation",
      "pack_enablement",
      "eval_receipt",
      "strategy_resolution_snapshot",
    ]) {
      expect(packList).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(packList).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(packList).toContain(
      'CREATE POLICY "pack_activation_scope_isolation" ON "pack_activation" USING ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" IS NULL OR "workspace_id" = current_workspace_id())',
    );
    expect(packList).toContain(
      'CREATE POLICY "pack_enablement_tenant_isolation" ON "pack_enablement" USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
    );
    expect(packList).toContain(
      'CREATE POLICY "strategy_resolution_snapshot_tenant_isolation" ON "strategy_resolution_snapshot" USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
    );
  });

  it("keeps published versions, activations, receipts and snapshots append-only", () => {
    expect(packList).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "pack_version" FROM app_user',
    );
    expect(packList).toContain('GRANT SELECT ON TABLE "pack_version" TO app_user');
    expect(packList).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "pack_activation" FROM app_user',
    );
    expect(packList).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "eval_receipt" FROM app_user',
    );
    expect(packList).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "strategy_resolution_snapshot" FROM app_user',
    );
    expect(packList).toContain(
      'GRANT UPDATE ("status", "status_reason", "status_updated_at", "status_updated_by", "active_version_id", "updated_at") ON TABLE "pack_package" TO app_user',
    );
  });

  it("matches the governance privilege manifest", () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, "utf8")) as {
      tables: Record<string, string[]>;
      columns: Record<string, Record<string, string[]>>;
    };
    expect(manifest.tables["pack_package"]).toEqual(["SELECT"]);
    expect(manifest.tables["pack_draft"]).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(manifest.tables["pack_version"]).toEqual(["SELECT"]);
    expect(manifest.tables["pack_activation"]).toEqual(["INSERT", "SELECT"]);
    expect(manifest.tables["pack_enablement"]).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(manifest.tables["eval_receipt"]).toEqual(["INSERT", "SELECT"]);
    expect(manifest.tables["strategy_resolution_snapshot"]).toEqual(["INSERT", "SELECT"]);
    expect(manifest.columns["pack_package"]).toEqual({
      active_version_id: ["UPDATE"],
      status: ["UPDATE"],
      status_reason: ["UPDATE"],
      status_updated_at: ["UPDATE"],
      status_updated_by: ["UPDATE"],
      updated_at: ["UPDATE"],
    });
  });

  it("extends skill_version with the service-kind binding and a closed one-of check", () => {
    const kindSql = readFileSync(`${MIGRATIONS}${SKILL_KIND_MIGRATION}/migration.sql`, "utf8");
    const kindList = statements(kindSql);
    expect(kindList).toContain('ALTER TABLE "skill_version" ALTER COLUMN "task_contract_id" DROP NOT NULL');
    expect(kindList).toContain(
      'ALTER TABLE "skill_version" ALTER COLUMN "task_contract_digest" DROP NOT NULL',
    );
    expect(kindList).toContain('ALTER TABLE "skill_version" ADD COLUMN "service_handler" TEXT');
    expect(statements(kindSql).join(" ")).toContain(
      '"service_handler" IS NOT NULL AND "task_contract_id" IS NULL AND "task_contract_digest" IS NULL',
    );
  });
});
