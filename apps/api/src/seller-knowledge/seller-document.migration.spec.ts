import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 静态契约（零容器）：seller_document / seller_document_chunk 的建表、部分唯一索引、
 * 生成列与 ANN/GIN 索引、RLS 与 app_user 授权。真库 as_user 行为由
 * app-user-table-privileges.postgres.spec.ts 在 CI 的 PostgreSQL job 覆盖。
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261103120000_seller_documents';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function statements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('seller documents migration（模块 02 · Phase 2）', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const list = statements(sql);

  it('additively follows the phase 1 migration in bounded transactions', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(
      names.indexOf('20261102170000_phase1_seller_sourcing_fields'),
    );
    expect(list[0]).toBe('BEGIN');
    expect(list.at(-1)).toBe('COMMIT');
    expect(list).toContain("SET LOCAL lock_timeout = '5s'");
    expect(list).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('creates seller_document with the designed column set and constraints', () => {
    const table = list.find((statement) => statement.startsWith('CREATE TABLE "seller_document"')) ?? '';
    const columns = [...table.matchAll(/"([a-z_]+)" (?:UUID|TEXT|BIGINT|INTEGER|VARCHAR\(64\)|VARCHAR\(120\)|TIMESTAMPTZ\(3\)|TIMESTAMP\(3\)|JSONB)/gu)].map(
      (match) => match[1],
    );
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'company_id',
      'uploaded_by',
      'filename',
      'mime',
      'size_bytes',
      'kind',
      'object_key',
      'content_hash',
      'status',
      'processing_stage',
      'processing_attempt',
      'lease_token',
      'lease_until',
      'retry_at',
      'processing_error_code',
      'parsed_meta',
      'chunk_count',
      'facts_extracted_at',
      'deleted_at',
      'deleted_by',
      'cleanup_event_id',
      'cleanup_completed_at',
      'created_at',
      'updated_at',
    ]);
    expect(table).toContain("CHECK (\"kind\" IN ('pdf', 'docx', 'pptx', 'txt', 'md', 'other'))");
    expect(table).toContain("'pending_upload'");
    expect(table).toContain("'failed_terminal'");
  });

  it('dedupes only active content via a partial unique index', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "seller_document_active_content_key" ON "seller_document" \("workspace_id", "company_id", "content_hash"\) WHERE "deleted_at" IS NULL AND "content_hash" IS NOT NULL;/u,
    );
  });

  it('creates the chunk table with generated tsvector, GIN and halfvec HNSW indexes', () => {
    expect(sql).toContain('"embedding" vector(1024)');
    expect(sql).toMatch(
      /"text_tsv" tsvector GENERATED ALWAYS AS \(to_tsvector\('simple', COALESCE\("text", ''\)\)\) STORED/u,
    );
    expect(sql).toContain('USING gin ("text_tsv")');
    expect(sql).toContain('USING hnsw (("embedding"::halfvec(1024)) halfvec_cosine_ops)');
    expect(sql).toContain('CREATE UNIQUE INDEX "seller_document_chunk_document_id_seq_key"');
  });

  it('enforces workspace isolation with forced RLS and least-privilege grants', () => {
    for (const table of ['seller_document', 'seller_document_chunk']) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`CREATE POLICY "${table}_tenant_isolation" ON "${table}"`);
      expect(sql).toContain('"workspace_id" = current_workspace_id()');
      expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO app_user;`);
    }
    const privileges = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as {
      tables: Record<string, string[]>;
    };
    expect(privileges.tables.seller_document).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(privileges.tables.seller_document_chunk).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('keeps the Prisma models in sync with the designed tables', () => {
    const schema = readFileSync(`${ROOT}packages/db/prisma/schema.prisma`, 'utf8');
    expect(schema).toMatch(/model SellerDocument \{/u);
    expect(schema).toMatch(/model SellerDocumentChunk \{/u);
    expect(schema).toContain('@map("seller_document")');
    expect(schema).toContain('@map("seller_document_chunk")');
    expect(schema).toContain('Unsupported("vector(1024)")');
  });
});
