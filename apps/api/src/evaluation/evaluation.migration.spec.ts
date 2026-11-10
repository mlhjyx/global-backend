import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../../packages/db/prisma/migrations/", import.meta.url));
const MIGRATION = "20261110060000_acquisition_evaluation";
const PRIVILEGES = fileURLToPath(
  new URL("../../../../docs/governance/app-user-table-privileges.json", import.meta.url),
);

function topLevelStatements(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/u, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

describe("acquisition evaluation migration（获客 vNext W3）", () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, "utf8");
  const statements = topLevelStatements(sql);

  it("is additive and bounded", () => {
    expect(readdirSync(MIGRATIONS)).toContain(MIGRATION);
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it("creates the four evaluation tables with shape checks", () => {
    for (const table of [
      "evaluation_set",
      "evaluation_label",
      "source_yield_ledger",
      "coverage_estimate",
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain("\"label\" IN ('POSITIVE', 'NEGATIVE')");
    expect(sql).toContain('"evaluation_set_version_check" CHECK ("version" >= 1)');
    expect(sql).toContain('"overlap_count" <= LEAST("count_a", "count_b")');
    expect(sql).toContain('"source_yield_ledger_run_provider_query_key"');
  });

  it("keeps every table under workspace RLS", () => {
    for (const table of [
      "evaluation_set",
      "evaluation_label",
      "source_yield_ledger",
      "coverage_estimate",
    ]) {
      expect(statements).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(statements).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    // 策略统一按 current_workspace_id()
    expect(sql.match(/USING \("workspace_id" = current_workspace_id\(\)\)/gu)).toHaveLength(4);
  });

  it("grants match the manifest: facts are append-only, labels may be re-labeled", () => {
    expect(statements).toContain('GRANT SELECT, INSERT ON TABLE "evaluation_set" TO app_user');
    expect(statements).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE "evaluation_label" TO app_user');
    expect(statements).toContain('GRANT SELECT, INSERT ON TABLE "source_yield_ledger" TO app_user');
    expect(statements).toContain('GRANT SELECT, INSERT ON TABLE "coverage_estimate" TO app_user');
    // append-only 两张事实表不得给 UPDATE/DELETE
    expect(sql).not.toMatch(/GRANT [^;]*UPDATE[^;]*"source_yield_ledger"/u);
    expect(sql).not.toMatch(/GRANT [^;]*UPDATE[^;]*"coverage_estimate"/u);
    expect(sql).not.toMatch(/GRANT [^;]*(?:DELETE|TRUNCATE)[^;]*TO app_user/u);

    const manifest = JSON.parse(readFileSync(PRIVILEGES, "utf8")) as {
      tables: Record<string, string[]>;
    };
    expect(manifest.tables.evaluation_set).toEqual(["INSERT", "SELECT"]);
    expect(manifest.tables.evaluation_label).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(manifest.tables.source_yield_ledger).toEqual(["INSERT", "SELECT"]);
    expect(manifest.tables.coverage_estimate).toEqual(["INSERT", "SELECT"]);
  });

  it("labels are pinned to the same workspace's set by a composite foreign key", () => {
    expect(sql).toContain(
      '"evaluation_label_set_fkey" FOREIGN KEY ("workspace_id", "set_id")\n    REFERENCES "evaluation_set"("workspace_id", "id")',
    );
    expect(sql).toContain(
      '"source_yield_ledger_run_fkey" FOREIGN KEY ("workspace_id", "run_id")\n    REFERENCES "discovery_run"("workspace_id", "id")',
    );
  });
});
