import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const enumMigration = new URL(
  '../../../../packages/db/prisma/migrations/20261108163000_campaign_plan_purpose_enum/migration.sql',
  import.meta.url,
);
const useMigration = new URL(
  '../../../../packages/db/prisma/migrations/20261108163100_campaign_plan_purpose_use/migration.sql',
  import.meta.url,
);

describe('campaign.plan purpose migrations (M2.1)', () => {
  it('adds the enum value in its own forward-only migration', async () => {
    const sql = await readFile(enumMigration, 'utf8');

    expect(sql).toContain(
      `ALTER TYPE "execution_budget_purpose"\n  ADD VALUE IF NOT EXISTS 'campaign.plan' AFTER 'outreach.draft';`,
    );
    expect(sql).not.toMatch(/DROP\s+TYPE/i);
    // PostgreSQL cannot use a value added in the same transaction.
    expect(sql).not.toContain('CREATE FUNCTION');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('teaches the authority CHECK and the workspace consume function the campaign arm', async () => {
    const sql = await readFile(useMigration, 'utf8');

    // workspace 分支新增 purpose 值 + (purpose, subject_type) 对。
    expect(sql).toContain(`'discovery.run', 'contact.verify', 'outreach.draft', 'campaign.plan'`);
    expect(sql).toContain(
      `OR ("purpose" = 'campaign.plan' AND "subject_type" = 'campaign')`,
    );
    expect(sql).toContain(
      `OR (p_purpose = 'campaign.plan' AND p_subject_type = 'campaign')`,
    );
    // 既有分支逐字保留（抽样关键不变式）。
    expect(sql).toContain(`OR ("purpose" = 'outreach.draft' AND "subject_type" = 'lead')`);
    expect(sql).toContain(`AND "crawl_run_id" IS NULL`);
    expect(sql).toContain(`"purpose" = 'platform.channel_crawl'`);
    // 只重建两个定义，不删表/列、不改历史行。
    expect(sql).toContain(
      `ADD CONSTRAINT "execution_budget_authority_kind_shape_check"`,
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION consume_workspace_execution_authority(',
    );
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/UPDATE\s+"execution_budget_authority"/i);
  });
});
