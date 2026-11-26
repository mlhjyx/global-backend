import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const enumMigration = new URL(
  '../../../../packages/db/prisma/migrations/20261126120000_icp_rejudge_purpose_enum/migration.sql',
  import.meta.url,
);
const useMigration = new URL(
  '../../../../packages/db/prisma/migrations/20261126120100_icp_rejudge_purpose_use/migration.sql',
  import.meta.url,
);

describe('icp.rejudge purpose migrations (Batch 1.7B-2)', () => {
  it('adds the enum value in its own forward-only migration outside a transaction', async () => {
    const sql = await readFile(enumMigration, 'utf8');

    expect(sql).toContain(
      `ALTER TYPE "execution_budget_purpose"\n  ADD VALUE IF NOT EXISTS 'icp.rejudge' AFTER 'icp.query_plan';`,
    );
    expect(sql).not.toMatch(/DROP\s+TYPE/i);
    expect(sql).not.toMatch(/\bBEGIN\b/i);
    // PostgreSQL cannot use a newly added enum value in the same transaction.
    expect(sql).not.toContain('CREATE FUNCTION');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('updates kind_shape_check, admission_lease_check, and consume_workspace_execution_authority with a 60-minute lease', async () => {
    const sql = await readFile(useMigration, 'utf8');

    expect(sql).toContain(`'icp.design', 'icp.query_plan', 'icp.rejudge', 'understanding.run',`);
    expect(sql).toContain(`OR ("purpose" = 'icp.rejudge' AND "subject_type" = 'icp')`);
    expect(sql).toContain(`"purpose" = 'icp.rejudge'`);
    expect(sql).toContain(`AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '60 minutes'`);
    expect(sql).toContain(`OR (p_purpose = 'icp.rejudge' AND p_subject_type = 'icp')`);
    expect(sql).toContain(`WHEN p_purpose = 'icp.rejudge' AND p_subject_type = 'icp'`);
    expect(sql).toContain(`THEN admitted_at + INTERVAL '60 minutes'`);

    // Existing workspace & platform arms stay intact verbatim.
    expect(sql).toContain(`OR ("purpose" = 'market.candidates.generate' AND "subject_type" = 'market_candidate_generation')`);
    expect(sql).toContain(`"purpose" = 'platform.channel_crawl'`);
    expect(sql).toContain(`ADD CONSTRAINT "execution_budget_authority_kind_shape_check"`);
    expect(sql).toContain(`ADD CONSTRAINT "execution_budget_authority_admission_lease_check"`);
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION consume_workspace_execution_authority(`);
    expect(sql).toContain(`SECURITY DEFINER`);
    expect(sql).toContain(`SET search_path = pg_catalog, public, pg_temp`);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/UPDATE\s+"execution_budget_authority"/i);
  });
});
