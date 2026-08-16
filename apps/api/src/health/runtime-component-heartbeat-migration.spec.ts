import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../packages/db/prisma/migrations/20260812130000_runtime_component_heartbeat/migration.sql",
  ),
  "utf8",
);

describe("runtime component heartbeat migration invariants", () => {
  it("is a platform-only additive table with bounded component and state values", () => {
    expect(migration).toContain('CREATE TABLE "runtime_component_heartbeat"');
    expect(migration).toContain(
      "CHECK (\"component\" IN ('WORKER', 'OUTBOX_RELAY'))",
    );
    expect(migration).toContain("CHECK (\"state\" IN ('RUNNING', 'STOPPED'))");
    expect(migration).not.toMatch(
      /UPDATE\s+"(?:outbox_event|canonical_company|lead)"/iu,
    );
  });

  it("lets app_user inspect but not forge or erase runtime evidence", () => {
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE "runtime_component_heartbeat" FROM app_user',
    );
    expect(migration).toContain(
      'GRANT SELECT ON TABLE "runtime_component_heartbeat" TO app_user',
    );
  });

  it("indexes the latest heartbeat by component", () => {
    expect(migration).toContain(
      '"runtime_component_heartbeat_component_freshness_idx"',
    );
    expect(migration).toContain(
      '"runtime_component_heartbeat"("component", "heartbeat_at" DESC)',
    );
  });
});
