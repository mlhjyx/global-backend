import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../packages/db/prisma/migrations/20260813010000_provider_quality_ledger/migration.sql'),
  'utf8',
);
const upgradeMigration = readFileSync(
  resolve(
    process.cwd(),
    '../../packages/db/prisma/migrations/20260813013000_provider_quality_ledger_v2_columns/migration.sql',
  ),
  'utf8',
);

describe('provider quality ledger migration invariants', () => {
  it('creates one immutable contribution per workspace, run and provider', () => {
    expect(migration).toContain('provider_quality_run_contribution_workspace_run_provider_key');
    expect(migration).toContain('UNIQUE ("workspace_id", "run_id", "provider_key")');
    expect(migration).toContain('REVOKE UPDATE, DELETE ON TABLE "provider_quality_run_contribution" FROM app_user');
  });

  it('stores attempt/run denominators and constrains every rate to at most one', () => {
    for (const column of ['attempted_count', 'success_count', 'zero_result_count', 'failure_count', 'failed_run_count', 'processed_count']) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toContain('"failed_run_count" IN (0, 1)');
    expect(migration).toContain('"duplicate_count" <= "processed_count"');
    expect(migration).toContain('"bound_count" <= "accepted_count"');
  });

  it('rejects app_user preoccupation by validating inserts against the terminal parent run stats', () => {
    expect(migration).toContain('provider_quality_contribution_insert_guard');
    expect(migration).toContain("parent_status NOT IN ('DONE', 'PARTIAL', 'FAILED')");
    expect(migration).toContain("parent_stats -> 'perProvider' -> NEW.provider_key");
    expect(migration).toContain('provider quality contribution does not match parent run facts');
  });

  it('forces symmetric workspace RLS and prevents cross-workspace run linkage', () => {
    expect(migration).toContain('ALTER TABLE "provider_quality_run_contribution" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "provider_quality_run_contribution" FORCE ROW LEVEL SECURITY');
    expect(migration).toMatch(/USING \("workspace_id" = current_workspace_id\(\)\)[\s\S]+WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/u);
    expect(migration).toContain('FOREIGN KEY ("workspace_id", "run_id")');
  });

  it('contains no historical backfill or mutable aggregate table', () => {
    expect(migration).not.toMatch(/INSERT\s+INTO[\s\S]+SELECT/iu);
    expect(migration).not.toMatch(/UPDATE\s+"discovery_run"/iu);
    expect(migration).not.toContain('provider_quality_aggregate');
  });
});

describe('provider quality ledger forward upgrade invariants', () => {
  it('wraps the entire upgrade in an explicit PostgreSQL transaction', () => {
    expect(upgradeMigration.trimStart().indexOf('BEGIN;')).toBeGreaterThanOrEqual(0);
    expect(upgradeMigration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(upgradeMigration.indexOf('BEGIN;')).toBeLessThan(upgradeMigration.indexOf('ADD COLUMN IF NOT EXISTS'));
  });

  it('temporarily removes and then restores the immutable update guard', () => {
    const dropAt = upgradeMigration.indexOf('DROP TRIGGER IF EXISTS "provider_quality_run_contribution_update_guard"');
    const backfillAt = upgradeMigration.indexOf('UPDATE "provider_quality_run_contribution" contribution');
    const restoreAt = upgradeMigration.indexOf('CREATE TRIGGER "provider_quality_run_contribution_update_guard"');
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(backfillAt).toBeGreaterThan(dropAt);
    expect(restoreAt).toBeGreaterThan(backfillAt);
  });

  it('temporarily disables RLS for a non-superuser owner and restores both mutation guards', () => {
    const disableAt = upgradeMigration.indexOf('DISABLE ROW LEVEL SECURITY');
    const backfillAt = upgradeMigration.indexOf('UPDATE "provider_quality_run_contribution" contribution');
    const enableAt = upgradeMigration.indexOf('ENABLE ROW LEVEL SECURITY');
    expect(disableAt).toBeGreaterThan(upgradeMigration.indexOf('BEGIN;'));
    expect(backfillAt).toBeGreaterThan(disableAt);
    expect(enableAt).toBeGreaterThan(backfillAt);
    expect(upgradeMigration).toContain('CREATE TRIGGER "provider_quality_run_contribution_update_guard"');
    expect(upgradeMigration).toContain('CREATE TRIGGER "provider_quality_run_contribution_delete_guard"');
  });

  it('fails closed when complete parent execution facts cannot be reconstructed', () => {
    expect(upgradeMigration).toContain('provider quality v2 migration cannot reconstruct incomplete historical facts');
    expect(upgradeMigration).toContain(") IS NOT TRUE");
    expect(upgradeMigration).not.toMatch(/COALESCE\("attempted_count",\s*1\)/u);
    for (const field of [
      'attemptedCount',
      'successCount',
      'zeroResultCount',
      'failureCount',
      'rawCount',
      'quarantinedCount',
      'rejectedCount',
      'duplicateCount',
    ]) {
      expect(upgradeMigration).toContain(`'${field}'`);
    }
    for (const column of ['attempted_count', 'success_count', 'zero_result_count', 'failed_run_count', 'processed_count']) {
      expect(upgradeMigration).toContain(`contribution."${column}" IS NULL`);
    }
  });

  it('rejects old rows whose immutable parent or identity facts disagree', () => {
    expect(upgradeMigration).toContain('provider quality v2 migration found a historical row inconsistent with parent run facts');
    for (const field of [
      '"icp_id" IS DISTINCT FROM run."icp_id"',
      '"terminal_status" IS DISTINCT FROM run."status"',
      '"completed_at" IS DISTINCT FROM run."completed_at"',
      "run.\"status\" NOT IN ('DONE', 'PARTIAL', 'FAILED')",
      'run."completed_at" IS NULL',
      'acceptedRows',
      'boundRows',
      'domainRows',
      'authorityIdentifierRows',
      'conflictRows',
    ]) {
      expect(upgradeMigration).toContain(field);
    }
  });

  it('reasserts FORCE RLS, symmetric tenant policy and least privilege', () => {
    expect(upgradeMigration).toContain('ALTER TABLE "provider_quality_run_contribution" FORCE ROW LEVEL SECURITY');
    expect(upgradeMigration).toMatch(/USING \("workspace_id" = current_workspace_id\(\)\)[\s\S]+WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/u);
    expect(upgradeMigration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "provider_quality_run_contribution" FROM app_user');
  });
});
