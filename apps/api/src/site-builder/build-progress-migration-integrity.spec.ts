import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../../..');
const migration = readFileSync(
  path.join(
    repo,
    'packages/db/prisma/migrations/20260717070000_site_builder_r3b2_progress/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  path.join(repo, 'packages/db/prisma/schema.prisma'),
  'utf8',
);

describe('R3-B2 SiteBuildStep database invariants', () => {
  it('binds every step to the same-workspace BuildRun without mutable provenance', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain('LOCK TABLE "site_build_run"');
    expect(migration).toMatch(
      /FOREIGN KEY \("build_run_id", "workspace_id"\)[\s\S]+REFERENCES "site_build_run"\("id", "workspace_id"\)[\s\S]+ON DELETE CASCADE[\s\S]+ON UPDATE NO ACTION/,
    );
    expect(schema).toMatch(
      /buildRun SiteBuildRun @relation\(fields: \[buildRunId, workspaceId\], references: \[id, workspaceId\][\s\S]+onUpdate: NoAction\)/,
    );
  });

  it('enforces bounded legal state, progress and one record per logical attempt', () => {
    expect(migration).toMatch(
      /status" IN \('queued', 'running', 'done', 'degraded', 'failed', 'skipped', 'aborted'\)/,
    );
    expect(migration).toContain('"attempt" >= 1');
    expect(migration).toContain('"progress" >= 0 AND "progress" <= 1');
    expect(migration).toContain('site_build_step_key_check');
    expect(migration).toContain('site_build_step_phase_check');
    expect(migration).toContain('site_build_step_terminal_time_check');
    expect(migration).toContain('char_length("item_key") <= 512');
    expect(migration).toContain('char_length("error_code") <= 128');
    expect(migration).toMatch(
      /UNIQUE INDEX "site_build_step_build_run_id_key_item_key_attempt_key"[\s\S]+"build_run_id", "key", "item_key", "attempt"/,
    );
  });

  it('forces workspace RLS and grants only the workspace-scoped application role', () => {
    expect(migration).toContain(
      'ALTER TABLE "site_build_step" ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE "site_build_step" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toMatch(
      /USING \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(migration).toMatch(
      /WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(migration).toContain('TO app_user');
  });
});
