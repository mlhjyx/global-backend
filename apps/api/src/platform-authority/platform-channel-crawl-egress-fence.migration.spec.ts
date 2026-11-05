import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL(
  "../../../../packages/db/prisma/migrations/20261105020000_platform_channel_crawl_egress_fence/migration.sql",
  import.meta.url,
);

describe("platform channel-crawl egress fence migration (P4-P4a)", () => {
  it("creates a capability fence seeded fail-closed and a dedicated attempt table", async () => {
    const sql = await readFile(migration, "utf8");

    expect(sql).toContain('CREATE TABLE "platform_egress_capability_fence"');
    expect(sql).toContain(
      `INSERT INTO "platform_egress_capability_fence"("capability_id") VALUES ('channel-crawl')`,
    );
    expect(sql).toContain('CREATE TABLE "platform_channel_crawl_egress_attempt"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "platform_channel_crawl_attempt_run_operation_key"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "platform_channel_crawl_attempt_authority_operation_key"',
    );
  });

  it("keeps every schedule fence object untouched", async () => {
    const sql = await readFile(migration, "utf8");

    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION (authorize|claim|lock|install|inspect)_platform_(egress|schedule)/i,
    );
    expect(sql).not.toContain('ALTER TABLE "platform_egress_schedule_fence"');
    expect(sql).not.toContain('ALTER TABLE "platform_egress_attempt"');
    expect(sql).not.toMatch(/DROP\s+(TABLE|FUNCTION)/i);
  });

  it("publishes policy fingerprints only through the owner-only installer", async () => {
    const sql = await readFile(migration, "utf8");

    expect(sql).toContain(
      "CREATE FUNCTION install_platform_egress_capability_policy_v1(",
    );
    expect(sql).toContain(
      "SELECT pg_get_userbyid(p.proowner) FROM pg_proc p",
    );
    expect(sql).toContain(
      "PLATFORM_EGRESS_POLICY_GENERATION_CONFLICT",
    );
    expect(sql).toContain(
      "'reason', 'POLICY_GENERATION_CHANGED'",
    );
  });

  it("re-checks authority, revocation, policy generation and reserved budget at both send stages", async () => {
    const sql = await readFile(migration, "utf8");

    expect(sql).toContain(
      "CREATE FUNCTION lock_platform_channel_crawl_egress_budget_v1(",
    );
    expect(sql).toContain(
      "CREATE FUNCTION authorize_platform_channel_crawl_egress_v1(",
    );
    expect(sql).toContain(
      "CREATE FUNCTION claim_platform_channel_crawl_egress_send_v1(",
    );
    expect(sql).toContain("execution_budget_authority_revocation");
    expect(sql).toContain("PLATFORM_EGRESS_POLICY_DRIFT");
    expect(sql).toContain("PLATFORM_EGRESS_BUDGET_NOT_AUTHORIZED");
    expect(sql).toContain(
      `'platform:' || authority.request_sha256 || ':' || authority.crawl_run_id`,
    );
    expect(sql).toContain(
      `authority.purpose::text IS DISTINCT FROM 'platform.channel_crawl'`,
    );
    expect(sql).toContain(
      `authority.subject_type IS DISTINCT FROM 'source_channel'`,
    );
  });

  it("sets pg_temp-last search paths and grants execute only to the platform writer", async () => {
    const sql = await readFile(migration, "utf8");

    const functionBlocks = sql.split("CREATE FUNCTION ").slice(1);
    expect(functionBlocks.length).toBe(7);
    for (const block of functionBlocks) {
      expect(block).toContain(
        "SET search_path = pg_catalog, public, pg_temp",
      );
    }
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION inspect_platform_egress_capability_policy_v1\(TEXT\),[\s\S]*?FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay, execution_budget_platform_writer;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION inspect_platform_egress_capability_policy_v1\(TEXT\),[\s\S]*?TO execution_budget_platform_writer;/,
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION install_platform_egress_capability_policy_v1(TEXT,BIGINT,TEXT,TEXT),",
    );
  });
});
