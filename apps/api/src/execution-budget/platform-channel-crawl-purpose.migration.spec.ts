import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const enumMigration = new URL(
  '../../../../packages/db/prisma/migrations/20261105000000_platform_channel_crawl_purpose_enum/migration.sql',
  import.meta.url,
);
const useMigration = new URL(
  '../../../../packages/db/prisma/migrations/20261105001000_platform_channel_crawl_purpose_use/migration.sql',
  import.meta.url,
);

describe('platform.channel_crawl purpose migrations (P4)', () => {
  it('adds the enum value in its own forward-only migration', async () => {
    const sql = await readFile(enumMigration, 'utf8');

    expect(sql).toContain(
      `ALTER TYPE "execution_budget_purpose"\n  ADD VALUE IF NOT EXISTS 'platform.channel_crawl' AFTER 'platform.sanctions';`,
    );
    expect(sql).not.toMatch(/DROP\s+TYPE/i);
    // The use-phase changes must not share this transaction (PostgreSQL cannot
    // use a value added in the same transaction).
    expect(sql).not.toContain('CREATE FUNCTION');
  });

  it('adds a nullable crawl_run_id without fabricating historical values', async () => {
    const sql = await readFile(useMigration, 'utf8');

    expect(sql).toMatch(/ADD COLUMN "crawl_run_id" VARCHAR\(36\)/i);
    expect(sql).not.toMatch(/UPDATE\s+"execution_budget_authority"/i);
    expect(sql).not.toMatch(/DEFAULT\s+['"][0-9a-f]/i);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it('extends both shape constraints with a separate crawl arm and keeps the schedule arms verbatim', async () => {
    const sql = await readFile(useMigration, 'utf8');

    // Schedule arms keep their exact invariants.
    expect(sql).toContain(
      `"purpose" IN (\n        'platform.acquisition', 'platform.intent_watch', 'platform.sanctions'\n      )`,
    );
    expect(sql).toContain(`"subject_type" IS NOT DISTINCT FROM 'schedule'`);
    expect(sql).toContain(`"subject_id" IS NOT DISTINCT FROM "schedule_id"`);
    expect(sql).toContain(
      `"campaign_cap_microusd" = "cap_per_run_microusd"`,
    );
    // Crawl arm: request-bound, channel subject, crawl run + policy revision.
    expect(sql).toContain(`"purpose" = 'platform.channel_crawl'`);
    expect(sql).toContain(`"subject_type" = 'source_channel'`);
    expect(sql).toContain(`"request_sha256" ~ '^[0-9a-f]{64}$'`);
    expect(sql).toContain(`"schedule_id" IS NULL`);
    expect(sql).toContain(
      `"crawl_run_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    );
    // Both constraint names are re-added, never dropped without replacement.
    expect(sql).toContain(
      `ADD CONSTRAINT "execution_budget_authority_kind_shape_check"`,
    );
    expect(sql).toContain(
      `ADD CONSTRAINT "execution_budget_authority_platform_run_binding_check"`,
    );
  });

  it('fences one crawl run to one authority below snapshot semantics', async () => {
    const sql = await readFile(useMigration, 'utf8');

    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "execution_budget_authority_platform_crawl_run_key"\s+ON "execution_budget_authority"\("crawl_run_id"\)\s+WHERE "authority_kind" = 'PLATFORM_GRANT'\s+AND "crawl_run_id" IS NOT NULL;/,
    );
    expect(sql).toContain(`'platform-crawl-run:'`);
    expect(sql).toMatch(
      /EXCEPTION\s+WHEN unique_violation THEN\s+RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'\s+USING ERRCODE = 'P0001';/,
    );
  });

  it('ingests and admits the exact signed crawl grant atomically without touching the schedule entry point', async () => {
    const sql = await readFile(useMigration, 'utf8');

    expect(sql).toContain(
      'CREATE FUNCTION ingest_and_admit_platform_channel_crawl_run_v1',
    );
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION ingest_and_admit_platform_execution_budget_run_v2',
    );
    expect(sql).toContain('assert_execution_budget_platform_writer_principal()');
    expect(sql).toContain("'execution-budget-jti:'");
    expect(sql).toContain("'authorized-tool-budget:platform:'");
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('attest_authorized_tool_budget_v1');
    expect(sql).toContain('open_authorized_tool_budget_v1');
    expect(sql).toContain('p_expected_request_sha256');
    expect(sql).toContain('p_expected_crawl_run_id');
    expect(sql).toContain('p_expected_technical_policy_revision');
    expect(sql).toContain('p_purpose IS DISTINCT FROM');
    expect(sql).toContain(`'platform:' || authority."request_sha256" || ':' ||\n    authority."crawl_run_id"`);
  });

  it('grants execute only to the platform writer role', async () => {
    const sql = await readFile(useMigration, 'utf8');

    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION ingest_and_admit_platform_channel_crawl_run_v1\([\s\S]*?\) FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION ingest_and_admit_platform_channel_crawl_run_v1\([\s\S]*?\) TO execution_budget_platform_writer;/,
    );
  });
});
