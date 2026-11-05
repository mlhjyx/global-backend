import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261105120000_source_channel_records';
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

describe('source channel records migration (物化)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('is additive and bounded', () => {
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('creates the platform record pool with company and PII-pending contact columns', () => {
    expect(sql).toContain('CREATE TABLE "source_channel_record"');
    for (const column of [
      '"dedupe_key" VARCHAR(200) NOT NULL',
      '"name" VARCHAR(300) NOT NULL',
      '"website" VARCHAR(2048)',
      '"country" VARCHAR(100)',
      '"industry" VARCHAR(200)',
      '"products" JSONB',
      '"keywords" JSONB',
      '"contact_name" VARCHAR(200)',
      '"contact_title" VARCHAR(200)',
      '"email" VARCHAR(320)',
      '"phone" VARCHAR(64)',
      '"source_url" VARCHAR(2048) NOT NULL',
      '"first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      '"last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      '"content_hash" VARCHAR(64)',
    ]) {
      expect(sql).toContain(column);
    }
    // PII_PENDING_ENCRYPTION 的延后决定必须写在迁移注释里（OWNER-DECISION-2026-11-05）。
    expect(sql).toContain('PII_PENDING_ENCRYPTION');
    expect(sql).toContain('OWNER-DECISION-2026-11-05');
    // 级联删除跟随渠道。
    expect(sql).toMatch(
      /"source_channel_record_channel_fkey" FOREIGN KEY \("channel_id"\)\s+REFERENCES "source_channel"\("id"\) ON DELETE CASCADE/u,
    );
  });

  it('enforces cross-run upsert identity and per-run attribution', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "source_channel_record_channel_dedupe_key"\s+ON "source_channel_record"\("channel_id", "dedupe_key"\)/u,
    );
    expect(sql).toMatch(/ALTER TABLE "source_channel_run"\s+ADD COLUMN "crawl_run_id" UUID/u);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "source_channel_run_crawl_run_key"\s+ON "source_channel_run"\("crawl_run_id"\)/u,
    );
  });

  it('keeps the platform table RLS-free and app_user write-scoped, listed in the closed privilege manifest', () => {
    expect(sql).not.toMatch(/ALTER TABLE "source_channel_record" ENABLE ROW LEVEL SECURITY/u);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE "source_channel_record" TO app_user/u);
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as Record<string, string[] | unknown>;
    const tables = (manifest.tables ?? manifest) as Record<string, string[]>;
    expect(tables.source_channel_record).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
