import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 静态契约（零容器）：M2 步 9b 迁移的建表/索引/RLS/app_user 授权。
 * 真库 as_user 行为由 agent-orchestration.postgres.spec.ts（CI PostgreSQL job）覆盖。
 */
const MIGRATIONS = fileURLToPath(new URL("../../../../packages/db/prisma/migrations/", import.meta.url));
const MIGRATION = "20261108150000_agent_orchestration_v0";

function statements(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/u, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

describe("agent orchestration v0 migration", () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, "utf8");
  const list = statements(sql);
  const flat = list.join("\n");

  it("is an additive bounded migration ordered after the skill runtime work", () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(
      names.indexOf("20261108130100_skill_service_kind"),
    );
    expect(list[0]).toBe("BEGIN");
    expect(list.at(-1)).toBe("COMMIT");
    expect(list).toContain("SET LOCAL lock_timeout = '5s'");
    expect(list).toContain("SET LOCAL statement_timeout = '30s'");
  });

  it("creates the registry and the append-only trace table", () => {
    for (const table of ["agent_profile", "agent_decision_trace"]) {
      expect(list.some((statement) => statement.startsWith(`CREATE TABLE "${table}"`))).toBe(true);
      expect(list).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(list).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(list).toContain(
      'CREATE UNIQUE INDEX "agent_profile_agent_key_key" ON "agent_profile" ("agent_key")',
    );
    expect(flat).toContain(
      'CONSTRAINT "agent_decision_trace_replay_key" UNIQUE ("workspace_id", "run_id", "step_type", "discriminator")',
    );
    expect(flat).toContain(
      'CONSTRAINT "agent_decision_trace_run_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "discovery_run"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
    expect(flat).toContain(
      'CONSTRAINT "agent_profile_status_check" CHECK ("status" IN (\'ACTIVE\', \'DISABLED\'))',
    );
    expect(flat).toContain(
      'CONSTRAINT "agent_decision_trace_actor_type_check" CHECK ("actor_type" = \'agent\')',
    );
  });

  it("isolates traces per workspace and keeps the registry platform-readable", () => {
    expect(list).toContain(
      'CREATE POLICY "agent_decision_trace_tenant_isolation" ON "agent_decision_trace" USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
    );
    expect(list).toContain(
      'CREATE POLICY "agent_profile_platform_visibility" ON "agent_profile" USING (true) WITH CHECK (true)',
    );
  });

  it("grants the application role only what each table's write path needs", () => {
    expect(list).toContain('GRANT SELECT ON TABLE "agent_profile" TO app_user');
    expect(list).toContain(
      'GRANT UPDATE ("status", "status_reason", "status_updated_at", "status_updated_by", "updated_at") ON TABLE "agent_profile" TO app_user',
    );
    expect(list).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "agent_profile" FROM app_user',
    );
    expect(list).toContain('GRANT SELECT, INSERT ON TABLE "agent_decision_trace" TO app_user');
    expect(list).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "agent_decision_trace" FROM app_user',
    );
  });
});
