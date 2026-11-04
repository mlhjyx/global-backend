import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M0①（Run 2.0 域模型）迁移的静态契约：三张新表、四组新列、租户 RLS 与权限清单。
 * 真实 PostgreSQL 行为（app_user 经 RLS 的读写、级联删除）由 CI 的 postgres 套件覆盖。
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261104110000_run2_domain_model';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);

function topLevelStatements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('Run 2.0 domain model migration (M0)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('runs additively in one bounded transaction, with no data rewrite', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('adds the run/pool/fit-cache columns expand-only (nullable or defaulted)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "discovery_run"\s+ADD COLUMN "task_ref" JSONB,\s+ADD COLUMN "phases" JSONB,\s+ADD COLUMN "mode" VARCHAR\(16\) NOT NULL DEFAULT 'full'/u,
    );
    expect(sql).toMatch(
      /ALTER TABLE "canonical_company"\s+ADD COLUMN "last_seen_at" TIMESTAMPTZ\(3\),\s+ADD COLUMN "last_checked_at" TIMESTAMPTZ\(3\),\s+ADD COLUMN "profile_hash" VARCHAR\(64\)/u,
    );
    expect(sql).toMatch(/ALTER TABLE "lead"\s+ADD COLUMN "fit_input_hash" VARCHAR\(64\)/u);
  });

  it('creates the three tables with tenant RLS and least-privilege grants', () => {
    for (const table of ['discovery_company_job', 'run_event', 'company_channel_sighting']) {
      expect(statements).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(statements).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      const policy = statements.find(
        (statement) => statement.startsWith('CREATE POLICY') && statement.includes(`"${table}"`),
      );
      expect(policy).toContain('USING ("workspace_id" = current_workspace_id())');
      expect(policy).toContain('WITH CHECK ("workspace_id" = current_workspace_id())');
    }
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "discovery_company_job" TO app_user/u,
    );
    // run_event 是 append-only 的进度事件。
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE "run_event" TO app_user/u);
    expect(sql).not.toMatch(
      /GRANT [^;]*(?:UPDATE|DELETE)[^;]* ON TABLE "run_event"/u,
    );
    expect(sql).toMatch(
      /GRANT SELECT, INSERT ON TABLE "company_channel_sighting" TO app_user/u,
    );
  });

  it('pins the state machine and event vocabulary with CHECK constraints', () => {
    expect(sql).toContain(`"stage" IN (`);
    for (const stage of ['queued', 'prefiltered_out', 'quick_judged', 'profiling', 'fitting', 'signals', 'contacts', 'done', 'failed', 'skipped']) {
      expect(sql).toContain(`'${stage}'`);
    }
    for (const type of ['phase_started', 'phase_completed', 'company_entered_stage', 'company_done', 'company_failed', 'budget_exhausted', 'lease_skipped', 'run_finished']) {
      expect(sql).toContain(`'${type}'`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX "run_event_run_seq_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "discovery_company_job_run_company_key"');
  });

  it('lists the new tables in the app_user privilege manifest', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as {
      tables: Record<string, string[]>;
    };
    expect(manifest.tables.discovery_company_job).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(manifest.tables.run_event).toEqual(['INSERT', 'SELECT']);
    expect(manifest.tables.company_channel_sighting).toEqual(['INSERT', 'SELECT']);
  });
});
