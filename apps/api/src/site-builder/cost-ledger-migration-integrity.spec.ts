import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../../..');
const migrationsDir = path.join(repo, 'packages/db/prisma/migrations');
const migrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4b_cost_ledger$/.test(entry),
);
const migration =
  migrationDirs.length === 1 &&
  existsSync(path.join(migrationsDir, migrationDirs[0]!, 'migration.sql'))
    ? readFileSync(
        path.join(migrationsDir, migrationDirs[0]!, 'migration.sql'),
        'utf8',
      )
    : '';
const schema = readFileSync(
  path.join(repo, 'packages/db/prisma/schema.prisma'),
  'utf8',
);

describe('R4-B persistent paid-call ledger database invariants', () => {
  it('ships one forward-only migration with durable budget, spend and task-attempt models', () => {
    expect(migrationDirs).toHaveLength(1);
    expect(schema).toContain('model SiteBuildBudget {');
    expect(schema).toContain('model SiteBuildSpend {');
    expect(schema).toContain('model SiteBuildTaskAttempt {');
    expect(migration).toContain('CREATE TABLE "site_build_budget"');
    expect(migration).toContain('CREATE TABLE "site_build_spend"');
    expect(migration).toContain('CREATE TABLE "site_build_task_attempt"');
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it('uses one logical BrandProfile attempt per build with a recoverable lease and fencing token', () => {
    expect(schema).toContain(
      '@@unique([buildRunId, taskId], map: "site_build_task_attempt_run_task_key")',
    );
    expect(schema).toMatch(
      /fenceToken\s+String\s+@map\("fence_token"\)\s+@db\.Uuid/,
    );
    expect(schema).toMatch(
      /leaseUntil\s+DateTime\s+@map\("lease_until"\)/,
    );
    expect(schema).toMatch(
      /taskAttemptId\s+String\?\s+@unique[^\n]+@map\("task_attempt_id"\)\s+@db\.Uuid/,
    );
    expect(migration).toMatch(
      /UNIQUE\s*\("build_run_id",\s*"task_id"\)/i,
    );
    expect(migration).toMatch(
      /brand_profile[\s\S]+task_attempt_id[\s\S]+FOREIGN KEY[\s\S]+site_build_task_attempt/i,
    );
  });

  it('serializes every physical paid operation and keeps measurement bases explicit', () => {
    expect(schema).toContain(
      '@@unique([buildRunId, operationKey], map: "site_build_spend_run_operation_key")',
    );
    for (const column of [
      'reservation_microusd',
      'budget_charge_microusd',
      'reported_cost_microusd',
      'calculated_cost_microusd',
      'estimated_cost_microusd',
      'cost_basis',
      'result_json',
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toMatch(
      /cost_basis[\s\S]+provider_reported[\s\S]+token_pricing[\s\S]+tool_reported[\s\S]+legacy_estimate[\s\S]+unknown/is,
    );
    expect(migration).toMatch(
      /UNIQUE\s*\("build_run_id",\s*"operation_key"\)/i,
    );
  });

  it('enforces non-negative budget arithmetic and an explicit paid-call kill switch', () => {
    expect(migration).toMatch(
      /cap_microusd[\s\S]+reserved_microusd[\s\S]+charged_microusd[\s\S]+CHECK/is,
    );
    expect(migration).toContain('"paid_calls_enabled" BOOLEAN NOT NULL DEFAULT true');
    expect(migration).toContain('"disabled_reason" TEXT');
    expect(migration).toContain('"exhausted_at" TIMESTAMP(3)');
    expect(migration).toMatch(
      /"cap_microusd"\s*>=\s*0[\s\S]+"reserved_microusd"\s*>=\s*0[\s\S]+"charged_microusd"\s*>=\s*0/is,
    );
  });

  it('implements atomic database reserve, settle and orphan reconciliation under row locks', () => {
    for (const fn of [
      'reserve_site_build_spend',
      'settle_site_build_spend',
      'reconcile_site_build_spend',
    ]) {
      expect(migration).toContain(`CREATE FUNCTION ${fn}`);
    }
    expect(migration).toMatch(
      /reserve_site_build_spend[\s\S]+FOR UPDATE[\s\S]+paid_calls_enabled[\s\S]+budget_exhausted/is,
    );
    expect(migration).toMatch(
      /settle_site_build_spend[\s\S]+FOR UPDATE[\s\S]+budget_charge_microusd/is,
    );
    expect(migration).toMatch(
      /reconcile_site_build_spend[\s\S]+status[^;]+RESERVED[\s\S]+UNKNOWN/is,
    );
  });

  it('forces tenant-symmetric RLS and grants no arbitrary deletes', () => {
    for (const table of [
      'site_build_budget',
      'site_build_spend',
      'site_build_task_attempt',
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY "${table}_tenant_isolation"[\\s\\S]+USING \\(\"workspace_id\" = current_workspace_id\\(\\)\\)[\\s\\S]+WITH CHECK \\(\"workspace_id\" = current_workspace_id\\(\\)\\)`,
        ),
      );
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO app_user`,
      );
      expect(migration).not.toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO app_user`,
      );
    }
  });
});
